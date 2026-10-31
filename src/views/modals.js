'use strict';

/*
 * modals —— 第 16 批从 app.js 搬出（原 app.js 719–3409 行，2691 行逐行原样，逻辑零改动）。
 *
 * 内容（按原顺序 24 个顶层函数 + 8 个顶层声明）：
 *   · 弹窗外壳：openModal / closeModal / confirmDialog / openCloseChoiceDialog /
 *     uninstallDialog / field（表单行）
 *   · 游戏与服务器：openGameModal / openDownloadModal / openServerModal
 *   · 游戏下载：DOWNLOAD_GAME_ENGINES / DOWNLOAD_UNSUPPORTED_SITES /
 *     DOWNLOAD_CHANNELS_OK / defaultDownloadDir / openGameDownloadModal
 *   · Sophon 差异更新：SOPHON_STAGES / SOPHON_PHASE_STAGE / sophonStageText /
 *     sophonProgressStats / stashTaskModal / restoreTaskModal / dropStashedTaskModal /
 *     renderTaskDock / pruneSophonHistory / startNextSophonJob / openSophonModal
 *     （hiddenTaskModal / hiddenTaskModalClose / taskModalGuard 是任务坞的三个游标）
 *   · 其它：formatSize / sameRoot / openLinkModal / openNewsModal
 *
 * 顶层声明为什么安全：这 8 个名字（5 个常量表 + 3 个 let 游标）在 app.js 剩余部分
 * 零引用（只有 3989 行一句注释提到 taskModalGuard），也没有任何更早加载的文件在顶层
 * 读它们 —— 搬走后既不会让 app.js 顶层 TDZ，也不会被前面的 views 抢先求值。
 * 常量表是纯字面量，三个 let 初值都是 null，加载期无副作用。
 */

/* ------------------------------------------------------------------ */
/* modals                                                              */
/* ------------------------------------------------------------------ */

function openModal(html, options = {}) {
  modalOnClose = options.onClose || null;
  dom.modalRoot.innerHTML = html;
  document.body.classList.add('modal-open');
  const backdrop = dom.modalRoot.querySelector('.modal-backdrop');
  const focusTarget =
    dom.modalRoot.querySelector('[autofocus]') ||
    dom.modalRoot.querySelector('input, textarea, button:not([data-close])');
  window.setTimeout(() => focusTarget && focusTarget.focus(), 60);
  if (backdrop) {
    backdrop.addEventListener('click', (event) => {
      if (event.target !== backdrop) return;
      if (options.onBackdrop) {
        options.onBackdrop();
        return;
      }
      closeModal();
    });
  }
}

function closeModal() {
  const callback = modalOnClose;
  modalOnClose = null;
  /*
   * 跑着的任务弹窗被关掉（Esc / ✕ / 点遮罩都走这里）时，先把它的 DOM 收进任务坞，
   * 再走正常的清空流程 —— 否则 #modal-root 一清空，任务条就再也回不到这个界面了。
   * 守卫只对「当前就在 #modal-root 里的那个任务弹窗」生效，不误伤别的弹窗。
   */
  if (taskModalGuard) {
    const guard = taskModalGuard;
    taskModalGuard = null;
    try {
      guard();
    } catch {
      /* 守卫只是尽力保住界面，失败也照常关 */
    }
  }
  dom.modalRoot.innerHTML = '';
  document.body.classList.remove('modal-open');
  if (callback) callback(false);
  if (state.app.version && state.route) {
    render({ preserveScroll: true });
  }
}

function confirmDialog({ title, message, confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    openModal(
      `<div class="modal-backdrop" data-backdrop>
        <div class="modal narrow" role="alertdialog" aria-modal="true">
          <div class="modal-head">
            <div><h2>${esc(title)}</h2></div>
            <button class="modal-close" data-close title="关闭">${icon('x')}</button>
          </div>
          <div class="modal-body"><p class="confirm-copy">${esc(message)}</p></div>
          <div class="modal-foot">
            <button class="btn btn-ghost" data-close>取消</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirm-yes">${esc(confirmText)}</button>
          </div>
        </div>
      </div>`,
      {
        onClose: () => resolve(false),
      }
    );
    const yes = document.querySelector('#confirm-yes');
    if (yes) {
      yes.addEventListener('click', () => {
        modalOnClose = null;
        dom.modalRoot.innerHTML = '';
        document.body.classList.remove('modal-open');
        resolve(true);
      });
    }
  });
}

/**
 * 第一次点右上角 ✕ 时的询问框：收进托盘，还是退出程序。
 *
 * 勾上「以后不再询问」→ 选择由主进程写进 settings.closeAction，以后点 ✕
 * 直接照它执行、不再弹这个框；不勾就只执行这一次，下次还会问。
 * 想换一种方式去 设置 → 行为 → 关闭时收进托盘。
 * 关掉这个框（✕ / Esc / 点遮罩）＝ 取消关闭，窗口继续开着。
 */
function openCloseChoiceDialog() {
  if (document.querySelector('#close-choice')) return;
  openModal(
    `<div class="modal-backdrop" data-backdrop>
      <div class="modal narrow" id="close-choice" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div><h2>关闭窗口</h2></div>
          <button class="modal-close" data-close title="取消">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <p class="confirm-copy">想怎么关掉花筱灵？</p>
          <label class="check-line">
            <input type="checkbox" id="close-choice-remember" checked />
            <span>以后不再询问，都按这次的选择执行</span>
          </label>
          <p class="setting-hint">想换一种方式：设置 → 行为 → 关闭时收进托盘。</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" id="close-choice-tray">${icon('chevron-down')}收进托盘</button>
          <button class="btn btn-danger" id="close-choice-quit">${icon('x')}退出启动器</button>
        </div>
      </div>
    </div>`,
    {
      // 没做选择就关掉：放开主进程的询问锁，下次点 ✕ 还能再问一遍
      onClose: () => api.closeAskCancel?.(),
    }
  );
  const pick = (choice) => {
    // 勾选状态要在 closeModal 之前读：那一步会把 #modal-root 清空
    const remember = document.querySelector('#close-choice-remember')?.checked !== false;
    // 先收掉弹窗再执行：收进托盘/退出之后窗口就不在了，别把弹窗留在隐藏窗口里
    closeModal();
    api.closeChoice?.(choice, remember);
  };
  document.querySelector('#close-choice-tray')?.addEventListener('click', () => pick('tray'));
  document.querySelector('#close-choice-quit')?.addEventListener('click', () => pick('quit'));
}

/**
 * 卸载前让用户在「回收站」和「永久删除」之间自己选。
 *
 * 不塞进 confirmDialog：那边只有一个「确定」，而这两条路的代价完全不同 ——
 * 一条还能捞回来，一条删了就没了。放在同一个按钮里，用户会默认点下去然后后悔。
 * 返回 'trash' / 'force' / null（取消）。
 */
function uninstallDialog({ title, message, root, exists }) {
  return new Promise((resolve) => {
    if (!exists) {
      // 目录本来就不在了：没有删文件这回事，只剩清记录
      confirmDialog({
        title,
        message,
        confirmText: '清除记录',
        danger: true,
      }).then((ok) => resolve(ok ? 'force' : null));
      return;
    }
    openModal(
      `<div class="modal-backdrop" data-backdrop>
        <div class="modal narrow" role="alertdialog" aria-modal="true">
          <div class="modal-head">
            <div><h2>${esc(title)}</h2></div>
            <button class="modal-close" data-close title="关闭">${icon('x')}</button>
          </div>
          <div class="modal-body">
            <p class="confirm-copy">${esc(message)}</p>
            ${
              root
                ? `<p class="uninstall-path" title="${esc(root)}">${esc(root)}</p>`
                : ''
            }
            <ul class="uninstall-pick">
              <li>
                <strong>移到回收站</strong>
                <span>推荐。删错了还能从回收站拖回来。</span>
              </li>
              <li>
                <strong>永久删除</strong>
                <span>不进回收站，删完就找不回来了。回收站用不了时选这个。</span>
              </li>
            </ul>
          </div>
          <div class="modal-foot uninstall-foot">
            <button class="btn btn-ghost" data-close>取消</button>
            <button class="btn btn-danger" data-uninstall-choice="force">永久删除</button>
            <button class="btn btn-primary" data-uninstall-choice="trash">移到回收站</button>
          </div>
        </div>
      </div>`,
      { onClose: () => resolve(null) }
    );
    dom.modalRoot.querySelectorAll('[data-uninstall-choice]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const value = btn.dataset.uninstallChoice;
        modalOnClose = null;
        dom.modalRoot.innerHTML = '';
        document.body.classList.remove('modal-open');
        resolve(value);
      });
    });
  });
}

function field(label, input, hint = '', required = false) {  return `<div class="field">
    <label>${esc(label)}${required ? '<span class="req">*</span>' : ''}</label>
    ${input}
    ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
  </div>`;
}

function openGameModal(id = null) {
  editingId = id || null;
  const game = id ? state.games.find((g) => g.id === id) : null;
  editingCover = game ? game.cover : null;
  editingCoverUrl = game ? game.coverUrl : null;
  const title = game ? '编辑游戏' : '添加游戏';
  const subtitle = game ? '修改资料不会影响游戏文件。' : '只需要一个启动程序，其他都可以以后慢慢补。';

  const cover = editingCoverUrl
    ? `<img id="cover-preview-img" src="${esc(editingCoverUrl)}" alt="封面预览" data-cover />`
    : `<div class="placeholder">${icon('image')}<span>横版封面 · 16:9</span></div>`;

  const html = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal" role="dialog" aria-modal="true">
        <form id="game-form" novalidate>
          <div class="modal-head">
            <div><h2>${title}</h2><p>${subtitle}</p></div>
            <button type="button" class="modal-close" data-close title="关闭">${icon('x')}</button>
          </div>
          <div class="modal-body">
            ${game && game.demo ? `<div class="form-note">${icon('info')}<span>这是一个示例条目。选择启动程序并保存后，它就会变成真正的游戏。</span></div>` : ''}
            <div class="form-grid">
              <div class="cover-editor">
                <div class="cover-preview" id="cover-preview">${cover}</div>
                <div class="cover-editor-actions">
                  <button type="button" class="btn btn-ghost" id="pick-cover">${icon('image')}选择封面</button>
                  ${
                    editingCover
                      ? `<button type="button" class="btn btn-quiet" id="remove-cover" title="移除封面">${icon('trash')}</button>`
                      : ''
                  }
                </div>
                <span class="hint">图片会被复制到应用数据目录，原图移动不受影响。</span>
              </div>
              <div>
                ${field(
                  '游戏名称',
                  `<input name="name" id="game-name" maxlength="80" value="${esc(game ? game.name : '')}" placeholder="例如：Aurora Drift" autofocus />`,
                  '',
                  true
                )}
                ${field('副标题', `<input name="subtitle" maxlength="80" value="${esc(game ? game.subtitle : '')}" placeholder="一句短描述，可选" />`)}
                <div class="field-row">
                  ${field('版本', `<input name="version" maxlength="32" value="${esc(game ? game.version : '')}" placeholder="1.0.0" />`)}
                  ${field('标签', `<input name="tags" maxlength="120" value="${esc(game && game.tags ? game.tags.join(', ') : '')}" placeholder="竞速, 单人" />`)}
                </div>
                ${field(
                  '启动程序',
                  `<div class="input-group">
                    <input name="target" id="game-target" value="${esc(game ? game.target : '')}" placeholder="选择 .exe / .lnk / .url，或直接填写" spellcheck="false" />
                    <button type="button" class="btn btn-ghost" id="pick-exe">${icon('folder')}浏览</button>
                  </div>`,
                  '也可以填写 steam:// 这样的协议链接。示例条目暂时留空即可。'
                )}
                ${field('启动参数', `<input name="args" maxlength="1000" value="${esc(game ? game.args : '')}" placeholder='例如：--windowed --profile "My Profile"' spellcheck="false" />`, '带空格的参数请用英文引号包起来。')}
                ${field(
                  '工作目录',
                  `<div class="input-group">
                    <input name="workDir" id="game-workdir" value="${esc(game ? game.workDir : '')}" placeholder="默认使用启动程序所在目录" spellcheck="false" />
                    <button type="button" class="btn btn-ghost" id="pick-workdir">${icon('folder')}浏览</button>
                  </div>`,
                  '少数游戏需要从特定目录启动才能读取资源。'
                )}
                ${field('简介', `<textarea name="description" maxlength="600" placeholder="写下一点关于这个游戏的记忆或说明…">${esc(game ? game.description : '')}</textarea>`)}
                <label class="check-line">
                  <input type="checkbox" id="game-favorite" ${game && game.favorite ? 'checked' : ''} />
                  <span>加入收藏，让它在首页更靠前</span>
                </label>
                <div class="field-error" id="form-error"></div>
              </div>
            </div>
          </div>
        </form>
        <div class="modal-foot">
          ${game ? `<button type="button" class="btn btn-danger left" data-action="delete-game" data-id="${esc(game.id)}">${icon('trash')}移除</button>` : ''}
          <button type="button" class="btn btn-ghost" data-close>取消</button>
          <button type="submit" form="game-form" class="btn btn-primary" id="save-game">${game ? '保存修改' : '添加到游戏库'}</button>
        </div>
      </div>
    </div>`;
  openModal(html);

  const form = document.querySelector('#game-form');
  const error = document.querySelector('#form-error');
  const nameInput = document.querySelector('#game-name');
  const targetInput = document.querySelector('#game-target');
  const modalRemove = document.querySelector('.modal-foot [data-action="delete-game"]');
  if (modalRemove) {
    modalRemove.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleAction('delete-game', modalRemove.dataset.id, modalRemove);
      },
      true
    );
  }

  document.querySelector('#pick-cover').addEventListener('click', async () => {
    try {
      const source = await api.pick.image();
      if (!source) return;
      const imported = await api.importCover(source);
      editingCover = imported;
      editingCoverUrl = toFileUrl(imported);
      const preview = document.querySelector('#cover-preview');
      preview.innerHTML = `<img id="cover-preview-img" src="${esc(editingCoverUrl)}" alt="封面预览" data-cover />`;
      const remove = document.querySelector('#remove-cover');
      if (!remove) {
        const actions = document.querySelector('.cover-editor-actions');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-quiet';
        button.id = 'remove-cover';
        button.title = '移除封面';
        button.innerHTML = icon('trash');
        actions.appendChild(button);
        button.addEventListener('click', removeCover);
      }
    } catch (err) {
      toast(humanError(err), 'error');
    }
  });

  function removeCover() {
    editingCover = null;
    editingCoverUrl = null;
    document.querySelector('#cover-preview').innerHTML = `<div class="placeholder">${icon('image')}<span>横版封面 · 16:9</span></div>`;
    const button = document.querySelector('#remove-cover');
    if (button) button.remove();
  }

  const removeButton = document.querySelector('#remove-cover');
  if (removeButton) removeButton.addEventListener('click', removeCover);

  document.querySelector('#pick-exe').addEventListener('click', async () => {
    const target = await api.pick.executable();
    if (!target) return;
    targetInput.value = target;
    if (!nameInput.value.trim()) {
      nameInput.value = target.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    }
    const dirInput = document.querySelector('#game-workdir');
    if (dirInput && !dirInput.value.trim()) {
      dirInput.placeholder = target.replace(/[\\/][^\\/]+$/, '');
    }
  });

  document.querySelector('#pick-workdir').addEventListener('click', async () => {
    const dir = await api.pick.directory();
    if (dir) document.querySelector('#game-workdir').value = dir;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const payload = {
      name: String(data.get('name') || '').trim(),
      subtitle: String(data.get('subtitle') || '').trim(),
      version: String(data.get('version') || '').trim(),
      tags: String(data.get('tags') || '')
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 5),
      target: String(data.get('target') || '').trim(),
      args: String(data.get('args') || '').trim(),
      workDir: String(data.get('workDir') || '').trim(),
      description: String(data.get('description') || '').trim(),
      cover: editingCover || '',
      accent: game ? game.accent : '#f08ba6',
      favorite: document.querySelector('#game-favorite').checked,
    };
    if (!payload.name) {
      error.textContent = '请先给它起一个名字。';
      nameInput.focus();
      return;
    }
    error.textContent = '';
    const save = document.querySelector('#save-game');
    save.disabled = true;
    save.textContent = '保存中…';
    try {
      if (editingId) {
        await api.games.update(editingId, payload);
        toast('游戏资料已更新', 'success');
      } else {
        await api.games.add(payload);
        toast('已添加到游戏库', 'success');
      }
      closeModal();
    } catch (err) {
      error.textContent = humanError(err);
      save.disabled = false;
      save.textContent = game ? '保存修改' : '添加到游戏库';
    }
  });
}

function openDownloadModal() {
  const dir = state.settings.downloadDir || '';
  const html = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal narrow" role="dialog" aria-modal="true">
        <form id="download-form" novalidate>
          <div class="modal-head">
            <div><h2>新建下载</h2><p>支持 http / https 直链，暂停后可断点续传。</p></div>
            <button type="button" class="modal-close" data-close title="关闭">${icon('x')}</button>
          </div>
          <div class="modal-body">
            ${field('下载链接', `<input name="url" id="download-url" placeholder="https://example.com/file.zip" spellcheck="false" autofocus />`, '', true)}
            ${field('保存为', `<input name="fileName" placeholder="留空则使用链接中的文件名" />`, '文件名中的非法字符会被自动替换。')}
            <div class="form-note">${icon('folder')}<span>保存到：${esc(dir)}<br />可以在设置里更改下载文件夹。</span></div>
            <div class="field-error" id="download-error"></div>
          </div>
          <div class="modal-foot">
            <button type="button" class="btn btn-ghost" data-close>取消</button>
            <button type="submit" class="btn btn-primary" id="start-download">${icon('download')}开始下载</button>
          </div>
        </form>
      </div>
    </div>`;
  openModal(html);

  const form = document.querySelector('#download-form');
  const error = document.querySelector('#download-error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const url = String(data.get('url') || '').trim();
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('只支持 http 或 https 链接');
    } catch {
      error.textContent = '请输入有效的 http 或 https 下载链接。';
      return;
    }
    error.textContent = '';
    const button = document.querySelector('#start-download');
    button.disabled = true;
    button.textContent = '正在创建…';
    try {
      await api.downloads.add({
        url,
        fileName: String(data.get('fileName') || '').trim(),
      });
      closeModal();
      if (state.route !== 'downloads') navigate('downloads');
      toast('下载任务已创建', 'success');
    } catch (err) {
      error.textContent = humanError(err);
      button.disabled = false;
      button.innerHTML = `${icon('download')}开始下载`;
    }
  });
}

function openServerModal(gameId, serverId = null) {
  const game = state.games.find((item) => item.id === gameId);
  if (!game) return;
  const server = serverId ? (game.servers || []).find((item) => item.id === serverId) : null;
  const html = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal narrow" role="dialog" aria-modal="true">
        <form id="server-form" novalidate>
          <div class="modal-head">
            <div>
              <h2>${server ? '编辑服务器' : '添加服务器'}</h2>
              <p>${esc(game.name)} · 为这个服务器的客户端指定启动程序。</p>
            </div>
            <button type="button" class="modal-close" data-close title="关闭">${icon('x')}</button>
          </div>
          <div class="modal-body">
            <div class="form-note">${icon('info')}<span>启动器会用启动程序所在的文件夹作为这个服务器的根目录，硬链接只会在两个服务器的根目录之间比较文件。</span></div>
            ${field(
              '服务器名称',
              `<input name="name" maxlength="40" value="${esc(server ? server.name : '')}" placeholder="例如：B服、国际服" autofocus />`,
              '',
              true
            )}
            ${field(
              '启动程序',
              `<div class="input-group">
                <input name="path" id="server-path" value="${esc(server ? server.path : '')}" placeholder="选择这个服务器的 .exe" spellcheck="false" />
                <button type="button" class="btn btn-ghost" id="pick-server-exe">${icon('folder')}浏览</button>
              </div>`,
              '不同服务器的客户端通常安装在不同目录，请选择对应客户端的启动程序。'
            )}
            <div class="field">
              <label>根目录（安装目录）</label>
              <div class="path-box">
                <input id="server-root" value="${esc(server && server.root ? server.root : '')}" placeholder="留空时自动使用启动程序所在文件夹" spellcheck="false" style="flex:1;min-width:0" />
                <button type="button" class="btn btn-ghost" id="pick-server-root">${icon('folder')}浏览</button>
              </div>
              <span class="hint">硬链接会在两个服务器的根目录之间比较文件。有些客户端把游戏文件放在启动程序的上一级目录，可以在这里手动指定。</span>
            </div>
            <div class="field-error" id="server-error"></div>
          </div>
          <div class="modal-foot">
            <button type="button" class="btn btn-ghost" data-close>取消</button>
            <button type="submit" class="btn btn-primary" id="save-server">${server ? '保存修改' : '添加服务器'}</button>
          </div>
        </form>
      </div>
    </div>`;
  openModal(html);

  const form = document.querySelector('#server-form');
  const pathInput = document.querySelector('#server-path');
  const rootInput = document.querySelector('#server-root');
  const error = document.querySelector('#server-error');

  function syncRootFromPath() {
    if (rootInput.dataset.manual === '1') return;
    const value = pathInput.value.trim();
    rootInput.value = value ? value.replace(/[\\/][^\\/]+$/, '') : '';
  }
  pathInput.addEventListener('input', syncRootFromPath);
  rootInput.addEventListener('input', () => { rootInput.dataset.manual = '1'; });
  syncRootFromPath();

  document.querySelector('#pick-server-exe').addEventListener('click', async () => {
    const picked = await api.pick.executable();
    if (!picked) return;
    pathInput.value = picked;
    rootInput.dataset.manual = '0';
    syncRootFromPath();
    const name = form.querySelector('[name="name"]');
    if (!name.value.trim()) {
      name.value = game.builtin ? '另一个服务器' : '默认';
      name.select();
    }
  });

  document.querySelector('#pick-server-root').addEventListener('click', async () => {
    const picked = await api.pick.directory();
    if (!picked) return;
    rootInput.value = picked;
    rootInput.dataset.manual = '1';
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const serverPath = String(data.get('path') || '').trim();
    const serverRoot = String(data.get('root') || '').trim();
    const name = String(data.get('name') || '').trim();
    if (!name) {
      error.textContent = '先给这个服务器起一个名字。';
      return;
    }
    if (!serverPath) {
      error.textContent = '请选择这个服务器的启动程序。';
      return;
    }
    const button = document.querySelector('#save-server');
    button.disabled = true;
    try {
      if (server) {
        await api.servers.update({ gameId, serverId: server.id, name, path: serverPath, root: serverRoot });
        toast('服务器配置已更新', 'success');
      } else {
        await api.servers.add({ gameId, name, path: serverPath, root: serverRoot });
        toast('服务器已添加', 'success');
      }
      closeModal();
    } catch (err) {
      error.textContent = humanError(err);
      button.disabled = false;
    }
  });
}

/*
 * ── 一键下载弹窗（未安装游戏） ─────────────────────────────────────────
 * 启动页「下载游戏」按钮走这里：选渠道 → 选目录 → 空间预估 → 开始下载。
 * 进度复用 sophon:progress 通道，任务面板 / 暂停 / 停止 / 最小化都和硬链接任务同一套。
 */
/** 支持一键下载的内置游戏 → 下载引擎（与主进程 DOWNLOADABLE_KEYS 保持一致）。 */
const DOWNLOAD_GAME_ENGINES = {
  genshin: 'sophon',
  starrail: 'sophon',
  zzz: 'sophon',
  bh3: 'sophon',
  endfield: 'endfield',
  arknights: 'endfield',
};

/** 暂不支持自动下载的游戏 → 官网入口（弹窗里如实说明后跳转）。 */
const DOWNLOAD_UNSUPPORTED_SITES = {
  neverness: 'https://yh.wanmei.com/',
};

/*
 * 接入了一键下载、但只实测过部分渠道的游戏 → 允许下载的渠道白名单。
 * 崩坏3 只有官服在 HoYoPlay 分发体系里（B服走 B 站自有启动器、国际服 game_id
 * 无法唯一定位）；明日方舟只实测了官服分发接口。渠道行本身还在，只是下载弹窗
 * 里不列出，避免用户选了才在 estimate 阶段报错。
 */
const DOWNLOAD_CHANNELS_OK = {
  bh3: ['official'],
  arknights: ['official'],
};

/**
 * 未安装游戏的默认安装目录：跟随现有游戏安装盘。
 * 哪个内置游戏已经装好了，就把它的安装盘借过来（比如原神装在 D 盘，新游戏默认
 * D:\HuaXiaoLingGames\<builtinKey>）；一个都没装时退回 C 盘。
 * 目录名用 builtinKey 而不是中文名，避免个别老游戏对中文路径的兼容问题。
 */
function defaultDownloadDir(game) {
  const installedRoot = ((state.games || []).map((item) =>
    (item.servers || []).find((server) => server.exists && server.root)
  ).find(Boolean) || {}).root || '';
  // 盘符必须用正则整体取出（含冒号），再一次性拼接。
  // 之前 slice(0,2)+' 截取后重新拼 ':' 的写法会拼出 "G:\:\..." 这种坏路径，
  // 直接导致 mkdir ENOENT、空间预估失败。
  const m = /^([a-zA-Z]:)[\\/]/.exec(installedRoot);
  const drive = m ? m[1] : 'C:';
  return `${drive}\\HuaXiaoLingGames\\${game.builtinKey || 'game'}`;
}

function openGameDownloadModal(gameId) {
  const game = state.games.find((item) => item.id === gameId);
  if (!game) return;

  // 没接入下载管线的游戏（异环）：如实说明 + 官网入口，不假装能下
  if (!DOWNLOAD_GAME_ENGINES[game.builtinKey]) {
    const site = DOWNLOAD_UNSUPPORTED_SITES[game.builtinKey] || '';
    openModal(`
      <div class="modal-backdrop" data-backdrop>
        <div class="modal narrow" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div>
              <h2>暂不支持自动下载</h2>
              <p>${esc(game.name)} 还没有接入一键下载。</p>
            </div>
            <button class="modal-close" data-close title="关闭">${icon('x')}</button>
          </div>
          <div class="modal-body">
            <p class="sw-note">${icon('info', 'xs')}<span>这款游戏暂时不能在启动器里直接下载安装：官方没有开放的版本清单接口。请先前往官网下载安装，装好后再用启动页的「自动检测」或「路径选择」把客户端指进来。</span></p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" data-close>关闭</button>
            ${site ? `<button class="btn btn-primary" data-action="open-external" data-url="${esc(site)}">${icon('external')}打开官网</button>` : ''}
          </div>
        </div>
      </div>`);
    return;
  }

  // 已有硬链接 / 更新 / 下载任务在跑时不再叠加：下载队列和硬链接队列共用一套任务面板，
  // 这里不排队，避免排到的下载任务被 openSophonModal 顶成硬链接弹窗。
  if (activeSophonJob || sophonJobs.some((job) => ['starting', 'running', 'queued'].includes(job.status))) {
    toast('已有下载 / 硬链接任务在进行，请先等它完成再下载新游戏', 'info');
    return;
  }

  const servers = (game.servers || []).filter((server) => !server.exists || server.incomplete);
  const allChoices = servers.length ? servers : game.servers || [];
  // 只实测过的渠道才列进下载弹窗（崩坏3 / 明日方舟只有官服），其余渠道不出现
  const allowedChannels = DOWNLOAD_CHANNELS_OK[game.builtinKey];
  const choices = allowedChannels ? allChoices.filter((server) => allowedChannels.includes(server.channel)) : allChoices;
  if (!choices.length) {
    toast('这个游戏还没有可用的服务器渠道', 'error');
    return;
  }
  // 新任务开始：把上一次收在坞里的旧弹窗丢掉，免得点任务条时挂回来的是上一单的界面
  dropStashedTaskModal();
  const jobId = `dl-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const channelOptions = choices
    .map(
      (server, index) => `
      <label class="dl-channel${index === 0 ? ' is-active' : ''}">
        <input type="radio" name="dl-channel" value="${esc(server.channel)}" ${index === 0 ? 'checked' : ''} />
        <span class="dl-channel-dot"></span>
        <span class="dl-channel-copy">
          <strong>${esc(server.name)}</strong>
          <small>${esc(serverChannelTag(game, server) || server.channel)}</small>
        </span>
      </label>`
    )
    .join('');

  const html = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h2>下载游戏 · ${esc(game.name)}</h2>
            <p>从官方清单完整下载安装，装完自动填好服务器路径。</p>
          </div>
          <div class="modal-head-actions">
            <button class="modal-close" id="dl-minimize" style="display:none" title="最小化到任务面板">−</button>
            <button class="modal-close" data-close title="关闭">${icon('x')}</button>
          </div>
        </div>
        <div class="modal-body">
          <p class="sw-note">${icon('info', 'xs')}<span>下载使用官方渠道的版本清单与分块，逐文件校验后落盘；整个过程保持游戏关闭。</span></p>
          <div class="field">
            <label>下载渠道</label>
            <div class="dl-channels">${channelOptions}</div>
          </div>
          <div class="field">
            <label>安装目录</label>
            <div class="input-group">
              <input id="dl-dir" value="${esc(defaultDownloadDir(game))}" spellcheck="false" />
              <button type="button" class="btn btn-ghost" id="dl-detect" title="扫描注册表和常见目录，找已经装好的客户端">${icon('refresh')}自动检测</button>
              <button type="button" class="btn btn-ghost" id="dl-browse" title="选择安装目录">${icon('folder')}浏览</button>
            </div>
            <span class="hint">默认跟随现有游戏的安装盘；也可以直接输入一个不存在的目录，下载时会自动创建。</span>
          </div>
          <div class="sw-sum">
            <div class="sw-sum-row">
              <span class="sw-sum-k">目标版本</span>
              <span class="sw-sum-v" id="dl-sum-tag">统计中…</span>
            </div>
            <div class="sw-sum-row">
              <span class="sw-sum-k">需要下载</span>
              <span class="sw-sum-v" id="dl-sum-size">统计中…</span>
            </div>
            <div class="sw-sum-row">
              <span class="sw-sum-k">目标盘剩余</span>
              <span class="sw-sum-v" id="dl-sum-free">统计中…</span>
            </div>
            <div class="sw-sum-row">
              <span class="sw-sum-k">空间判断</span>
              <span class="sw-sum-v" id="dl-sum-space">统计中…</span>
            </div>
            <p class="sw-sum-hint" id="dl-sum-hint">体积来自官方清单，语音包按设置里勾选的语言计算。</p>
          </div>
          <ol class="sw-stages" id="dl-stages">
            ${SOPHON_STAGES.map(
              (stage, index) => `
              <li class="sw-stage" data-index="${index}">
                <span class="sw-stage-dot">${index + 1}</span>
                <span class="sw-stage-label">${esc(stage.label)}</span>
              </li>`
            ).join('')}
          </ol>
          <div class="link-progress" id="dl-progress" style="display:none">
            <div class="link-progress-head">
              <strong id="dl-phase">准备中…</strong>
              <span id="dl-count"></span>
            </div>
            <div class="progress-bar"><span id="dl-bar" style="width:0%"></span></div>
            <div class="link-progress-meta">
              <span id="dl-stats"></span>
              <span id="dl-current"></span>
            </div>
          </div>
          <div class="sw-result" id="dl-result" hidden>
            <strong class="sw-result-title">下载完成</strong>
            <div class="sw-result-grid" id="dl-result-grid"></div>
            <p class="sw-result-note" id="dl-result-note"></p>
          </div>
          <div class="field-error" id="dl-error"></div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-close>关闭</button>
          <button class="btn btn-ghost" id="dl-pause" style="display:none">暂停</button>
          <button class="btn btn-ghost" id="dl-cancel" style="display:none">停止</button>
          <button class="btn btn-primary" id="dl-start">${icon('download')}开始下载</button>
        </div>
      </div>
    </div>`;

  /* 关窗回调单独拿个名字：任务收进任务坞再从任务条挂回来时，要把它一起装回去 */
  const taskOnClose = () => {
    if (running) {
      // 窗口在跑任务时被关掉：不取消下载，缩进任务面板继续跑
      minimized();
    } else {
      // 完成 / 失败的那一条留在坞里，用户回头看还能点回来
      pruneSophonHistory();
      renderTaskDock();
    }
    if (finishedOk) {
      // 关窗后按最新状态重绘启动页：已装好的游戏这里会变回「开始游戏」
      render({ preserveScroll: true });
    }
  };
  openModal(html, {
    onClose: taskOnClose,
    onBackdrop: () => {
      if (running) minimized();
      else closeModal();
    },
  });

  const start = document.querySelector('#dl-start');
  const cancel = document.querySelector('#dl-cancel');
  const pause = document.querySelector('#dl-pause');
  const minimizeBtn = document.querySelector('#dl-minimize');
  const progress = document.querySelector('#dl-progress');
  const errorBox = document.querySelector('#dl-error');
  const dirInput = document.querySelector('#dl-dir');
  const backdrop = document.querySelector('.modal-backdrop');

  const job = {
    id: jobId,
    gameId,
    serverId: choices[0].id,
    gameName: game.name,
    serverName: choices[0].name,
    mode: 'download',
    status: 'starting',
    percent: 0,
    phase: '准备中…',
    stats: '',
  };
  // 任务面板立刻可见：打开弹窗就算挂上任务，最小化后左下角能看到它
  sophonJobs.push(job);
  renderTaskDock();

  let running = false;
  let paused = false;
  let cancelled = false;
  let finishedOk = false;
  let unsubscribe = null;

  const hideDock = () => {
    if (activeSophonJob === job) activeSophonJob = null;
    sophonUi = null;
    taskModalGuard = null;
    document.body.classList.remove('sophon-minimized');
    renderTaskDock();
  };

  // 跑着的时候被关窗（✕ / Esc / 点遮罩）→ 收进任务坞，而不是把界面销毁
  taskModalGuard = () => {
    if (!running || !backdrop || !dom.modalRoot.contains(backdrop)) return false;
    hiddenTaskModalClose = taskOnClose;
    stashTaskModal(backdrop);
    return true;
  };

  // 最小化：弹窗藏起来，任务留在左下角任务面板里继续跑
  const minimized = () => {
    if (!running) return;
    // 整块 DOM 拔下来存着：中途开别的弹窗也不会把它冲掉，点任务条能原样挂回去
    hiddenTaskModalClose = taskOnClose;
    stashTaskModal(backdrop);
    document.body.classList.add('sophon-minimized');
    job.status = 'running';
    activeSophonJob = job;
    renderTaskDock();
    sophonUi = {
      restore: () => {
        restoreTaskModal();
      },
      cancel: () => {
        cancelled = true;
        running = false;
        job.status = 'cancelled';
        api.servers.cancelSophon(jobId).catch(() => {});
        dropStashedTaskModal();
        closeModal();
        hideDock();
        pruneSophonHistory();
      },
    };
  };

  minimizeBtn.addEventListener('click', minimized);

  // 右上角 ✕ 在跑任务时改成最小化，别让人误触把窗口关了以为任务没了
  const closeX = document.querySelector('.modal-head [data-close]');
  if (closeX) {
    closeX.addEventListener(
      'click',
      (event) => {
        if (running) {
          event.preventDefault();
          event.stopPropagation();
          minimized();
        }
      },
      true
    );
  }

  const updateDock = (phaseLabel, percent, stats, current, stage) => {
    job.phase = phaseLabel;
    job.percent = Math.max(0, Math.min(100, percent));
    job.stats = stats;
    job.current = current || '';
    if (stage !== undefined) job.stage = stage;
    if (activeSophonJob === job) renderTaskDock();
  };

  /* 阶段条只往前走：复用硬链接弹窗那套 SOPHON_STAGES，两处说法保持一致 */
  const stageBox = document.querySelector('#dl-stages');
  let stageIndex = -1;
  const paintStages = (index) => {
    if (!stageBox) return;
    if (index >= 0) stageIndex = Math.max(stageIndex, index);
    const finishedAll = stageIndex >= SOPHON_STAGES.length - 1;
    [...stageBox.querySelectorAll('.sw-stage')].forEach((node, i) => {
      const isDone = finishedAll || i < stageIndex;
      node.classList.toggle('is-done', isDone);
      node.classList.toggle('is-active', !finishedAll && i === stageIndex);
      node.querySelector('.sw-stage-dot').textContent = isDone ? '✓' : String(i + 1);
    });
  };

  const sumTag = document.querySelector('#dl-sum-tag');
  const sumSize = document.querySelector('#dl-sum-size');
  const sumFree = document.querySelector('#dl-sum-free');
  const sumSpace = document.querySelector('#dl-sum-space');
  const resultBox = document.querySelector('#dl-result');

  const selectedChannel = () => {
    const checked = document.querySelector('input[name="dl-channel"]:checked');
    return checked ? checked.value : choices[0].channel;
  };

  const restoreStart = () => {
    if (running || finishedOk) return;
    start.disabled = false;
    start.innerHTML = `${icon('download')}开始下载`;
  };

  /*
   * 空间预估：读官方清单拿全量体积，和目标盘剩余空间对比。
   * 换渠道或换目录都要重算 —— 渠道清单可能不同，目录换盘后剩余空间也变了。
   */
  const refreshEstimate = async () => {
    sumTag.textContent = '统计中…';
    sumSize.textContent = '统计中…';
    sumFree.textContent = '统计中…';
    sumSpace.textContent = '统计中…';
    sumSpace.classList.remove('is-warn', 'is-ok');
    errorBox.textContent = '';
    try {
      const result = await api.servers.downloadEstimate({
        gameId,
        channel: selectedChannel(),
        installDir: dirInput.value.trim(),
      });
      sumTag.textContent = result.version || '未知';
      sumSize.textContent = Number(result.totalBytes)
        ? `约 ${formatSize(result.totalBytes)}${result.storyResources?.count ? `（含可选剧情资源 ${formatSize(result.storyResources.bytes)}）` : ''}`
        : '未知';
      const free = Number(result.freeBytes) || 0;
      const need = Number(result.totalBytes) || 0;
      sumFree.textContent = free ? `${formatSize(free)}` : '读不到磁盘信息';
      if (!free || !need) {
        sumSpace.textContent = '判断不了，先按默认目录继续也可以';
      } else if (need > free) {
        sumSpace.textContent = '不够：请换个安装目录或先清理空间';
        sumSpace.classList.add('is-warn');
      } else {
        sumSpace.textContent = '够用';
        sumSpace.classList.add('is-ok');
      }
      restoreStart();
    } catch (error) {
      sumTag.textContent = '未知';
      sumSize.textContent = '未知';
      sumFree.textContent = '未知';
      sumSpace.textContent = humanError(error);
      sumSpace.classList.add('is-warn');
      errorBox.textContent = humanError(error);
      if (!running && !finishedOk) {
        start.disabled = true;
        start.textContent = '先按提示处理再开始';
      }
    }
  };

  document.querySelectorAll('input[name="dl-channel"]').forEach((input) => {
    input.addEventListener('change', () => {
      document.querySelectorAll('.dl-channel').forEach((node) => node.classList.remove('is-active'));
      input.closest('.dl-channel')?.classList.add('is-active');
      // 换渠道后 job 面板显示的名字也跟着换
      const server = choices.find((item) => item.channel === input.value);
      if (server) {
        job.serverId = server.id;
        job.serverName = server.name;
      }
      refreshEstimate();
    });
  });

  // 打开弹窗先算一遍：默认目录 + 第一个未安装渠道
  refreshEstimate();

  document.querySelector('#dl-browse').addEventListener('click', async () => {
    if (running) return;
    const dir = await api.pick.directory();
    if (!dir) return;
    dirInput.value = dir;
    refreshEstimate();
  });

  document.querySelector('#dl-detect').addEventListener('click', async () => {
    if (running) return;
    const result = await api.games.detect(gameId);
    if (result.ok) {
      toast('已找到已安装的客户端，路径已填进对应服务器', 'success');
      // 主进程已把路径写回服务器并回推状态；这里同步一份，关窗后启动页直接可开始
      await api.getState().then(onState).catch(() => {});
      closeModal();
      // 弹窗开着时 onState 不重绘，检测成功后手动刷一次启动页（变回「开始游戏」）
      render({ preserveScroll: true });
    } else {
      toast(result.error || '没有自动检测到，可以手动选目录后点「开始下载」', 'info');
    }
  });

  pause.addEventListener('click', async () => {
    paused = !paused;
    await api.servers.pauseSophon({ jobId, paused }).catch(() => {});
    pause.textContent = paused ? '继续' : '暂停';
    const phase = document.querySelector('#dl-phase');
    if (phase) phase.textContent = paused ? '已暂停（点继续恢复）' : '恢复中…';
    if (paused) updateDock('已暂停', job.percent, '点任务条恢复窗口');
  });

  const finishClose = () => {
    // onClose（openModal 的回调）里已经负责关窗后重绘，这里只关窗
    closeModal();
  };

  start.addEventListener('click', async () => {
    // 跑完之后这个按钮就是「完成」：关窗并重绘启动页
    if (finishedOk) {
      finishClose();
      return;
    }
    const channel = selectedChannel();
    const installDir = dirInput.value.trim();
    if (!installDir) {
      errorBox.textContent = '请先填写或选择安装目录。';
      return;
    }
    running = true;
    cancelled = false;
    job.status = 'running';
    activeSophonJob = job;
    sophonUi = {
      restore: () => {
        if (backdrop) backdrop.style.display = '';
        document.body.classList.add('modal-open');
        document.body.classList.remove('sophon-minimized');
        renderTaskDock();
      },
      cancel: () => {
        cancelled = true;
        running = false;
        job.status = 'cancelled';
        api.servers.cancelSophon(jobId).catch(() => {});
        closeModal();
        hideDock();
      },
    };
    renderTaskDock();
    start.disabled = true;
    start.textContent = '正在下载…';
    cancel.style.display = '';
    minimizeBtn.style.display = '';
    pause.style.display = '';
    progress.style.display = 'block';
    errorBox.textContent = '';
    paintStages(0);
    unsubscribe = api.onSophonProgress((event) => {
      if (event.jobId !== jobId) return;
      const total = Number(event.total) || 0;
      const processed = Number(event.processed) || 0;
      const percent = total ? Math.min(100, (processed / total) * 100) : 0;
      const stage = SOPHON_PHASE_STAGE[event.phase] ?? 2;
      const phases = {
        start: '读取官方清单',
        version: `目标版本 ${event.tag || ''}`,
        manifest: '读取清单与分块索引',
        install: '写入文件',
        download: '下载分块',
        done: '完成',
      };
      if (event.tag && sumTag) sumTag.textContent = event.tag;
      paintStages(percent >= 100 && stage === 2 ? 3 : stage);
      document.querySelector('#dl-phase').textContent = phases[event.phase] || '处理中…';
      document.querySelector('#dl-count').textContent = total ? `${processed} / ${total}` : '';
      document.querySelector('#dl-bar').style.width = `${event.phase === 'done' ? 100 : percent}%`;
      const stats = sophonProgressStats(event);
      document.querySelector('#dl-stats').textContent = stats;
      document.querySelector('#dl-current').textContent = event.current || '';
      updateDock(
        phases[event.phase] || '处理中…',
        event.phase === 'done' ? 100 : percent,
        sophonProgressStats(event, true),
        event.current || '',
        stage
      );
    });

    try {
      const result = await api.servers.downloadGame({ gameId, channel, installDir, jobId });
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (result.cancelled || cancelled) {
        job.status = 'cancelled';
        pruneSophonHistory();
        toast('下载已取消', 'info');
        closeModal();
        hideDock();
        return;
      }
      if (!result.ok) throw new Error(result.error || '下载失败');
      finishedOk = true;
      running = false;
      job.status = 'done';
      job.percent = 100;
      pruneSophonHistory();
      // 最小化到任务面板时完成的：先把窗口恢复出来给用户看结果
      if (document.body.classList.contains('sophon-minimized') && sophonUi) sophonUi.restore();
      hideDock();
      if (cancel) cancel.style.display = 'none';
      if (pause) pause.style.display = 'none';
      if (minimizeBtn) minimizeBtn.style.display = 'none';
      start.disabled = false;
      start.textContent = '完成';
      paintStages(SOPHON_STAGES.length - 1);
      if (resultBox) {
        resultBox.hidden = false;
        resultBox.querySelector('#dl-result-grid').innerHTML = [
          { k: '目标版本', v: result.version || '—' },
          { k: '安装目录', v: result.targetRoot || installDir },
          { k: '启动程序', v: result.path || '—' },
        ]
          .map(
            (item) =>
              `<div class="sw-result-item"><span>${esc(item.k)}</span><strong>${esc(item.v)}</strong></div>`
          )
          .join('');
        resultBox.querySelector('#dl-result-note').textContent = '服务器路径已写好，回到启动页就能直接开始游戏。';
      }
      toast(`${game.name} 下载完成`, 'success');
      // 主进程在完成时已 pushState；弹窗开着时 onState 不重绘，这里主动同步一份最新状态
      await api.getState().then(onState).catch(() => {});
    } catch (error) {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      running = false;
      job.status = cancelled ? 'cancelled' : 'error';
      pruneSophonHistory();
      // 最小化状态下出错的：先恢复窗口，错误信息才看得见
      if (document.body.classList.contains('sophon-minimized') && sophonUi) sophonUi.restore();
      hideDock();
      if (cancelled) {
        toast('下载已取消', 'info');
        closeModal();
        return;
      }
      errorBox.textContent = humanError(error);
      start.disabled = false;
      start.innerHTML = `${icon('download')}重新开始`;
      cancel.style.display = 'none';
      pause.style.display = 'none';
      minimizeBtn.style.display = 'none';
    }
  });
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(0, Math.round(value / 1024))} KB`;
}

/*
 * 硬链接安装 / 更新的阶段表。
 *
 * 任务坞和弹窗共用这一份：以前两处各写一套文案（「写入文件」对「处理中…」），
 * 用户在弹窗里看到的和缩到角落时看到的不是同一句话，会以为任务被换掉了。
 */
const SOPHON_STAGES = [
  { key: 'manifest', label: '读清单' },
  { key: 'ldiff', label: '补丁修补' },
  { key: 'write', label: '写入 / 下载' },
  { key: 'verify', label: '校验收尾' },
  { key: 'done', label: '完成' },
];

/** 主进程推的 phase → 阶段下标。B服 走的 'link' 也是纯硬链接复用，归到写入阶段。 */
const SOPHON_PHASE_STAGE = {
  start: 0,
  version: 0,
  manifest: 0,
  // 终末地：切过去时先补下缺的那个渠道包，再进硬链接
  pack: 0,
  ldiff: 1,
  install: 2,
  download: 2,
  patch: 2,
  link: 2,
  done: 4,
};

/** 阶段下标 → 「第 N/5 步 · 阶段名」，弹窗与任务坞都从这里取。 */
function sophonStageText(index) {
  const clamped = Math.max(0, Math.min(SOPHON_STAGES.length - 1, Number(index) || 0));
  return `第 ${clamped + 1}/${SOPHON_STAGES.length} 步 · ${SOPHON_STAGES[clamped].label}`;
}

/**
 * 进度事件 → 一行数字。
 *
 * ldiff 阶段没有 linked / bytesDone，套统一模板会显示成「硬链接 0 · 下载 0 · 0 B」，
 * 看着像卡死；这里单独给它一句「已修补 N 个 · 省流 X」。
 */
function sophonProgressStats(event, compact = false) {
  if (!event) return '';
  if (event.phase === 'ldiff') {
    // 任务坞里前面已经有「第 2/5 步 · 补丁修补」，再带一次前缀就成了复读
    const head = compact ? '' : '本地补丁修补：';
    return `${head}已修补 ${event.applied || 0} 个 · 省流 ${formatSize(event.saveBytes || 0)}${
      event.failed ? ` · ${event.failed} 个改用下载` : ''
    }`;
  }
  if (event.phase === 'done') return '';
  return `硬链接 ${event.linked || 0} · 下载 ${event.downloaded || 0} · ${formatSize(
    event.bytesDone
  )} / ${formatSize(event.totalBytes)}`;
}

/*
 * 任务弹窗的「最小化 / 恢复」。
 *
 * 以前最小化只是把 backdrop 设成 display:none。只要中途打开任何别的弹窗
 * （openModal 会直接清空 #modal-root），任务弹窗的 DOM 就被销毁了；
 * 再点任务坞条目只会给 body 加一个 modal-open —— 界面灰着、什么也没有，
 * 于是「点任务条再也回不到硬链接界面」。
 * 现在最小化时把整块 DOM 拔出来存着，恢复时原样挂回去：
 * 进度条、阶段条、事件监听、滚动位置都还在。
 */
let hiddenTaskModal = null;
/**
 * 任务弹窗自己的 onClose。
 *
 * 恢复时要把它一起装回去：中途用户可能开过设置别的弹窗，modalOnClose 已经被
 * 那个弹窗接管了。只把 DOM 挂回来而不管它，关任务窗时会去跑别人的关闭回调。
 */
let hiddenTaskModalClose = null;

/** 把任务弹窗从 DOM 里拔下来存好（不是删掉），留着自己能原样挂回去。 */
function stashTaskModal(backdrop) {
  if (!backdrop || !backdrop.parentNode) return;
  backdrop.parentNode.removeChild(backdrop);
  hiddenTaskModal = backdrop;
  if (!dom.modalRoot.querySelector('.modal-backdrop')) {
    document.body.classList.remove('modal-open');
  }
}

/**
 * 把收起来的任务弹窗挂回前台。返回是否真的挂回去了。
 *
 * 先清空 #modal-root：这时用户可能正开着别的弹窗（设置 / 确认框），
 * 他点任务条就是要回到任务界面，旧的留在下面只会叠成两层。
 */
function restoreTaskModal() {
  const node = hiddenTaskModal;
  if (!node) return false;
  hiddenTaskModal = null;
  dom.modalRoot.innerHTML = '';
  dom.modalRoot.appendChild(node);
  modalOnClose = hiddenTaskModalClose || null;
  hiddenTaskModalClose = null;
  document.body.classList.add('modal-open');
  document.body.classList.remove('sophon-minimized');
  renderTaskDock();
  return true;
}

/**
 * 任务弹窗的关闭守卫：跑着的时候被关窗，先把 DOM 收进任务坞。
 * closeModal() 会调它，返回真表示「这次关窗已经被拦成了最小化」。
 */
let taskModalGuard = null;

/** 丢掉收起来的任务弹窗（任务被停止 / 已结束时用，避免留着僵尸节点）。 */
function dropStashedTaskModal() {
  hiddenTaskModal = null;
  hiddenTaskModalClose = null;
  taskModalGuard = null;
}

function renderTaskDock() {
  // 一键下载的任务也走这个坞：mode=download 显示「下载」，别混进「生成」
  const dock = document.querySelector('#task-dock');
  const list = document.querySelector('#task-dock-list');
  if (!dock || !list) return;
  /*
   * 坞里只放「还在跑 / 排队」的任务。
   *
   * 以前结束的任务会留两条在这儿，理由是「跑完想再看一眼」；实际用起来它就一直
   * 赖在左下角，96% 的空间和时间都没人点它。结果那一屏本来就留在前台，关掉之后
   * 也没必要再从坞里捡回来。
   */
  const visible = sophonJobs.filter((job) => ['queued', 'starting', 'running'].includes(job.status));
  if (!visible.length) {
    dock.hidden = true;
    document.body.classList.remove('sophon-minimized');
    return;
  }
  dock.hidden = false;
  // 渠道包下载也进这个坞（mode=pack），标题单独给一种说法
  const jobTitle = (job) => {
    const modeText =
      job.mode === 'update'
        ? '更新'
        : job.mode === 'download'
          ? '下载'
          : job.mode === 'pack'
            ? '渠道包'
            : '生成';
    return `${modeText} ${job.serverName}`;
  };
  list.innerHTML = `
    <div class="task-dock-head"><strong>进行中的任务</strong><span>${visible.length} 个</span></div>
    ${visible
      .map((job) => {
        if (job.status === 'queued') {
          return `
            <div class="task-dock-item task-dock-queued">
              <button class="task-dock-main" data-action="focus-sophon" data-id="${esc(job.id)}" title="排队中，前面的任务结束后自动开始">
                <span class="task-dock-icon">${icon('clock')}</span>
                <span class="task-dock-copy"><strong>${esc(job.serverName)}</strong><small>排队中 · ${esc(job.gameName)}</small></span>
              </button>
              <button class="task-dock-stop" data-action="remove-sophon-queue" data-id="${esc(job.id)}" title="取消排队">✕</button>
            </div>`;
        }
        if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
          const label =
            job.status === 'done' ? '已完成' : job.status === 'cancelled' ? '已停止' : '失败了';
          const glyph = job.status === 'done' ? 'check' : job.status === 'cancelled' ? 'clock' : 'alert';
          return `
            <div class="task-dock-item task-dock-ended is-${job.status}">
              <button class="task-dock-main" data-action="focus-sophon" data-id="${esc(job.id)}" title="重新打开这个界面">
                <span class="task-dock-icon">${icon(glyph)}</span>
                <span class="task-dock-copy">
                  <strong>${jobTitle(job)}</strong>
                  <small>${label}${job.percent >= 100 && job.status === 'done' ? ' · 100%' : ''}${
                    job.stats ? ` · ${esc(job.stats)}` : ''
                  }</small>
                </span>
              </button>
              <button class="task-dock-stop" data-action="dismiss-sophon-job" data-id="${esc(job.id)}" title="从列表里移除">✕</button>
            </div>`;
        }
        // 阶段文案和弹窗里的阶段条同源，缩到任务坞里也不会换一套说法
        const stepText = job.stage === undefined ? '' : `${sophonStageText(job.stage)}`;
        const phaseText = job.percent >= 100 ? '完成' : stepText || job.phase || '准备中…';
        return `
          <div class="task-dock-item">
            <button class="task-dock-main" data-action="focus-sophon" data-id="${esc(job.id)}" title="打开任务界面">
              <span class="task-dock-icon">${icon('download')}</span>
              <span class="task-dock-copy">
                <strong>${jobTitle(job)}</strong>
                <small>${esc(phaseText)}${job.stats ? ` · ${esc(job.stats)}` : ''}</small>
                <span class="task-dock-bar"><span style="width:${Math.max(0, Math.min(100, job.percent || 0))}%"></span></span>
              </span>
            </button>
            <button class="task-dock-stop" data-action="cancel-sophon-dock" data-id="${esc(job.id)}" title="停止">✕</button>
          </div>`;
      })
      .join('')}`;
}

/**
 * 只刷新坞里某一条的进度文字与进度条，不重建 innerHTML。
 *
 * renderTaskDock 每次都会重写整个列表。下载 / 生成时进度每秒来几十次，用户按住
 * 某一条的那一刻节点正好被换掉：mousedown 落在旧节点、mouseup 落在新节点，
 * 浏览器就不会派发 click —— 表现就是「点了缩小，坞里那一条怎么点都点不回来」。
 * 所以任务跑着的时候只改文字，结构只在「新增 / 结束一条」时才重建。
 */
function patchTaskDockJob(job) {
  const list = document.querySelector('#task-dock-list');
  if (!list) return false;
  const button = list.querySelector(`[data-id="${job.id}"]`);
  const row = button ? button.closest('.task-dock-item') : null;
  // 找不到这一条、或它已经不是「进行中」那种带进度条的行：交给整表重绘
  if (!row || !row.querySelector('.task-dock-bar')) return false;
  const small = row.querySelector('.task-dock-copy small');
  if (small) {
    const text = job.percent >= 100 ? '完成' : job.phase || '准备中…';
    small.textContent = job.stats ? `${text} · ${job.stats}` : text;
  }
  const fill = row.querySelector('.task-dock-bar > span');
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, job.percent || 0))}%`;
  return true;
}

/** 结束态的历史只留最近两条，否则坞会越堆越长。 */function pruneSophonHistory() {
  const ended = sophonJobs.filter((job) =>
    ['done', 'error', 'cancelled'].includes(job.status)
  );
  if (ended.length <= 2) return;
  const dropped = new Set(ended.slice(0, ended.length - 2));
  sophonJobs = sophonJobs.filter((job) => !dropped.has(job));
}

function startNextSophonJob() {
  if (activeSophonJob) return;
  const next = sophonJobs.find((job) => job.status === 'queued');
  if (!next) {
    renderTaskDock();
    return;
  }
  sophonJobs = sophonJobs.filter((job) => job !== next);
  setTimeout(() => openSophonModal(next.gameId, next.serverId, next.mode, { autoStart: true }), 450);
}

function openSophonModal(gameId, serverId, mode = 'prepare', options = {}) {
  const game = state.games.find((item) => item.id === gameId);
  const server = game && (game.servers || []).find((item) => item.id === serverId);
  if (!game || !server) return;
  const isUpdate = mode === 'update';
  const jobId = `sophon-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  /*
   * 生成中不再允许再开一个（以前是往后排队）。
   *
   * 排队这个设计在「硬链接」这种一跑几十分钟、又要占着客户端目录的操作上只会
   * 让人误会：点下去以为又要开始了，实际在后面排队，界面还停在原地。
   * 现在直接拦住，并把正在跑的那个界面捧回前台 —— 想看进度、想停，都在那一屏里。
   */
  if (!options.job) {
    const busy = activeSophonJob || sophonJobs.find((item) => ['starting', 'running'].includes(item.status));
    if (busy) {
      const same = busy.gameId === gameId && busy.serverId === serverId;
      if (same) restoreTaskModal();
      toast(
        same
          ? `${server.name} 正在生成，这一屏已经给你调回来了`
          : `「${busy.serverName}」正在生成，等它跑完再开下一个`,
        'info'
      );
      return;
    }
  }
  // 新任务开始：把上一次收在坞里的旧弹窗丢掉，免得点任务条时挂回来的是上一单的界面
  dropStashedTaskModal();
  const job = {
    id: jobId,
    gameId,
    serverId,
    gameName: game.name,
    serverName: server.name,
    mode,
    status: 'starting',
    percent: 0,
    phase: '准备中…',
    stats: '',
  };
  sophonJobs.push(job);
  renderTaskDock();
  let running = false;
  let cancelled = false;
  // 跑成功之后按钮会变成「完成」，finally 里不能再用「重新尝试」把它改回去
  let finishedOk = false;
  let unsubscribe = null;

  const html = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal modal-sophon" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h2>${isUpdate ? '更新' : '硬链接安装'} ${esc(server.name)} 客户端</h2>
            <p>${esc(game.name)} · ${isUpdate ? '检查并安装官方更新' : '以你已安装的客户端为源，硬链接相同文件，只下载差异分块'}</p>
          </div>
          <div class="modal-head-actions">
            <button class="modal-close" id="sophon-minimize" style="display:none" title="最小化">−</button>
            <button class="modal-close" data-close title="关闭">${icon('x')}</button>
          </div>
        </div>
        <div class="modal-body">
          <p class="sw-note">${icon('info', 'xs')}<span>${
            isUpdate
              ? '只下载和当前版本不一样的分块，其余文件就地校验保留。'
              : '内容相同的文件直接复用，只下载差异分块。'
          }</span></p>
          <details class="sw-note-more">
            <summary>这一步具体会做什么</summary>
            <p>${
              isUpdate
                ? '会对现有客户端逐文件校验，只下载版本不同或缺失的分块；官方清单之外的删除项不会动。有本地补丁的渠道会先就地修补，再补齐剩下的分块。'
                : '先和你已有的客户端逐文件比较：完全相同的文件建立硬链接复用，只下载不同或缺失的分块，所以实际新增占用通常远小于客户端总体积。'
            }整个过程都要保持游戏关闭。</p>
          </details>
          <div class="sw-sum">
            <div class="sw-sum-row">
              <span class="sw-sum-k">目标版本</span>
              <span class="sw-sum-v" id="sw-sum-tag">读清单后确定</span>
            </div>
            <div class="sw-sum-row">
              <span class="sw-sum-k">可复用上限</span>
              <span class="sw-sum-v" id="sw-sum-reuse">统计中…</span>
            </div>
            <div class="sw-sum-row">
              <span class="sw-sum-k">目标盘剩余</span>
              <span class="sw-sum-v" id="sw-sum-free">统计中…</span>
            </div>
            <div class="sw-sum-row">
              <span class="sw-sum-k">空间判断</span>
              <span class="sw-sum-v" id="sw-sum-space">统计中…</span>
            </div>
            <p class="sw-sum-hint" id="sw-sum-hint">
              要下载多少得等读完官方清单才知道，进度区会边跑边显示；「可复用上限」是基础客户端的体积，内容一致的部分不用再下一遍。
            </p>
          </div>
          <div class="sophon-target">
            <span>目标目录</span>
            <code id="sophon-target-dir">正在确定…</code>
            <button type="button" class="btn btn-ghost btn-sm" id="sophon-pick-dir" title="选一个目录当运行时根目录，启动器会在里面按 游戏\\渠道 建子目录">选择目录</button>
          </div>
          <ol class="sw-stages" id="sophon-stages">
            ${SOPHON_STAGES.map(
              (stage, index) => `
              <li class="sw-stage" data-index="${index}">
                <span class="sw-stage-dot">${index + 1}</span>
                <span class="sw-stage-label">${esc(stage.label)}</span>
              </li>`
            ).join('')}
          </ol>
          <div class="link-progress" id="sophon-progress" style="display:none">
            <div class="link-progress-head">
              <strong id="sophon-phase">准备中…</strong>
              <span id="sophon-count"></span>
            </div>
            <div class="progress-bar"><span id="sophon-bar" style="width:0%"></span></div>
            <div class="link-progress-meta">
              <span id="sophon-stats"></span>
              <span id="sophon-current"></span>
            </div>
          </div>
          <p class="sw-ldiff" id="sophon-ldiff" hidden></p>
          <div class="sw-result" id="sophon-result" hidden>
            <strong class="sw-result-title" id="sophon-result-title">已完成</strong>
            <div class="sw-result-grid" id="sophon-result-grid"></div>
            <p class="sw-result-note" id="sophon-result-note"></p>
          </div>
          <div class="field-error" id="sophon-error"></div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-close>关闭</button>
          <button class="btn btn-ghost" id="sophon-pause" style="display:none">暂停</button>
          <button class="btn btn-ghost" id="sophon-cancel" style="display:none">停止</button>
          <button class="btn btn-primary" id="sophon-start">${icon(isUpdate ? 'refresh' : 'download')}${isUpdate ? '开始更新' : '开始硬链接安装'}</button>
        </div>
      </div>
    </div>`;

  /* 关窗回调单独拿个名字：任务收进任务坞再从任务条挂回来时，要把它一起装回去 */
  const taskOnClose = () => {
    if (running) {
      /*
       * 跑着的时候关窗 = 收进任务坞继续跑，和下载弹窗同一套语义。
       * 以前这里是「关窗即取消」：误点一下 ✕ 几十秒的硬链接就白做了，
       * 而且任务条上再也点不回这个界面。真要停，界面里有「停止」。
       */
      minimizeTask();
    } else {
      // 完成 / 失败的那一条留在坞里，用户回头看还能点回来
      pruneSophonHistory();
      renderTaskDock();
    }
    // 队列在「完成」时没有被放行（那时窗口还开着看结果），关窗这一步才轮到下一个
    if (finishedOk) startNextSophonJob();
  };
  openModal(html, {
    onClose: taskOnClose,
    onBackdrop: () => {
      if (running) minimizeTask();
      else closeModal();
    },
  });

  const start = document.querySelector('#sophon-start');
  const cancel = document.querySelector('#sophon-cancel');
  const progress = document.querySelector('#sophon-progress');
  const errorBox = document.querySelector('#sophon-error');
  const minimize = document.querySelector('#sophon-minimize');
  const pause = document.querySelector('#sophon-pause');
  let paused = false;
  let selectedRuntimeRoot = '';
  const backdrop = document.querySelector('.modal-backdrop');
  const dock = document.querySelector('#task-dock');

  const hideDock = () => {
    if (activeSophonJob === job) activeSophonJob = null;
    sophonUi = null;
    taskModalGuard = null;
    document.body.classList.remove('sophon-minimized');
    renderTaskDock();
  };

  // 跑着的时候被关窗（✕ / Esc / 点遮罩）→ 收进任务坞，而不是把界面销毁
  taskModalGuard = () => {
    if (!running || !backdrop || !dom.modalRoot.contains(backdrop)) return false;
    hiddenTaskModalClose = taskOnClose;
    stashTaskModal(backdrop);
    return true;
  };

  const minimizeTask = () => {
    if (!running) return;
    // 整块 DOM 拔下来存着：中途开别的弹窗也不会把它冲掉，点任务条能原样挂回去
    hiddenTaskModalClose = taskOnClose;
    stashTaskModal(backdrop);
    document.body.classList.add('sophon-minimized');
    job.status = 'running';
    activeSophonJob = job;
    renderTaskDock();
    sophonUi = {
      restore: () => {
        restoreTaskModal();
      },
      cancel: () => {
        cancelled = true;
        running = false;
        job.status = 'cancelled';
        api.servers.cancelSophon(jobId).catch(() => {});
        dropStashedTaskModal();
        closeModal();
        hideDock();
        pruneSophonHistory();
        startNextSophonJob();
      },
    };
  };

  const updateDock = (phaseLabel, percent, stats, current, stage) => {
    job.phase = phaseLabel;
    job.percent = Math.max(0, Math.min(100, percent));
    job.stats = stats;
    job.current = current || '';
    // stage 只在真正拿到进度事件时写，暂停 / 排队这类状态不该把阶段条往回退
    if (stage !== undefined) job.stage = stage;
    if (activeSophonJob === job) renderTaskDock();
  };

  minimize.addEventListener('click', minimizeTask);

  // 开始按钮带了图标，恢复默认态必须还原 innerHTML，直接写 textContent 会把图标弄丢
  const startIdleHtml = start.innerHTML;
  const restoreStart = () => {
    if (running || finishedOk) return;
    start.disabled = false;
    start.innerHTML = startIdleHtml;
  };

  /* 阶段条：只往前走，不往回退。中途重试也从当前阶段继续，免得看着像回到原点。 */
  const stageBox = document.querySelector('#sophon-stages');
  let stageIndex = -1;
  let ldiffSeen = false;
  const paintStages = (index) => {
    if (!stageBox) return;
    if (index >= 0) stageIndex = Math.max(stageIndex, index);
    const finishedAll = stageIndex >= SOPHON_STAGES.length - 1;
    [...stageBox.querySelectorAll('.sw-stage')].forEach((node, i) => {
      const isDone = finishedAll || i < stageIndex;
      // 走到写入阶段还没见过 ldiff 事件，说明这个渠道没有本地补丁，第 2 步标成「跳过」而不是让它一直空着
      const isSkipped = !ldiffSeen && i === 1 && stageIndex > 1;
      node.classList.toggle('is-done', isDone && !isSkipped);
      node.classList.toggle('is-active', !finishedAll && i === stageIndex);
      node.classList.toggle('is-skipped', isSkipped);
      node.querySelector('.sw-stage-dot').textContent = isDone && !isSkipped ? '✓' : String(i + 1);
      node.querySelector('.sw-stage-label').textContent = isSkipped
        ? `${SOPHON_STAGES[i].label}（跳过）`
        : SOPHON_STAGES[i].label;
    });
  };

  const sumTag = document.querySelector('#sw-sum-tag');
  const sumReuse = document.querySelector('#sw-sum-reuse');
  const sumFree = document.querySelector('#sw-sum-free');
  const sumSpace = document.querySelector('#sw-sum-space');
  const ldiffLine = document.querySelector('#sophon-ldiff');
  const resultBox = document.querySelector('#sophon-result');

  /*
   * 结果卡：把「省了多少、哪些没走补丁」摆出来。
   *
   * 主进程只回数量（applied / failed / downloaded），没有失败文件的路径清单，
   * 所以这里如实写「N 个改用下载」，不假装能列出文件名。
   */
  const showResult = (result) => {
    if (!resultBox) return;
    const ldiff = result.ldiff || null;
    const items = [
      { k: '目标版本', v: result.tag || '—' },
      { k: '硬链接复用', v: `${result.linked || 0} 个文件` },
      { k: '实际下载', v: `${result.downloaded || 0} 个文件` },
    ];
    if (ldiff && ldiff.applied > 0) {
      items.push({ k: '本地补丁修补', v: `${ldiff.applied} 个 · 省流 ${formatSize(ldiff.saveBytes || 0)}` });
    }
    resultBox.querySelector('#sophon-result-title').textContent = isUpdate ? '更新完成' : '生成完成';
    resultBox.querySelector('#sophon-result-grid').innerHTML = items
      .map(
        (item) =>
          `<div class="sw-result-item"><span>${esc(item.k)}</span><strong>${esc(item.v)}</strong></div>`
      )
      .join('');
    const notes = [];
    if (result.targetRoot) notes.push(`目录：${result.targetRoot}`);
    if (ldiff && ldiff.failed) {
      notes.push(`${ldiff.failed} 个文件的补丁没能应用（可能被占用或校验不通过），已改走下载补齐。`);
    }
    if (result.directBase) {
      notes.push('官服直接用你自己的官方客户端，没有再生成一份副本。');
    } else if (result.packDownloaded) {
      notes.push('这次顺带补下了这个渠道的渠道包，下次切过来就不用再下了。');
    } else if (!ldiff) {
      notes.push('这次没有走本地补丁（这个渠道没有启用，或没有对应的旧版本补丁），全部按分块校验补齐。');
    }
    resultBox.querySelector('#sophon-result-note').textContent = notes.join(' ');
    resultBox.hidden = false;
  };

  /*
   * 结论卡：安装前先回答四个问题 —— 装哪个版本、能复用多少、目标盘还剩多少、够不够。
   *
   * 数据全部来自 prepareSophon 的 estimate 分支（freeBytes / baseBytes / drive / partial）。
   * 那个分支不返回「这次要下载多少字节」，所以这里不编数字：复用上限用基础客户端体积
   * 表述，下载量交给进度区边跑边显示。
   */
  const refreshEstimate = async () => {
    if (!sumReuse) return;
    sumReuse.textContent = '统计中…';
    sumFree.textContent = '统计中…';
    sumSpace.textContent = '统计中…';
    sumSpace.classList.remove('is-warn', 'is-ok');
    try {
      const result = await api.servers.prepareSophon({
        gameId,
        serverId,
        estimate: true,
        runtimeRoot: selectedRuntimeRoot || undefined,
      });
      if (!result || !result.ok) {
        const reason = (result && result.error) || '拿不到空间信息';
        sumReuse.textContent = '未知';
        sumFree.textContent = '未知';
        sumSpace.textContent = reason;
        sumSpace.classList.add('is-warn');
        // 这些前置条件（基础客户端、同盘运行时）不满足时真跑也会立刻失败，不如当场拦住
        if (errorBox) errorBox.textContent = reason;
        if (!running && !finishedOk) {
          start.disabled = true;
          start.textContent = '先按提示处理再开始';
        }
        return;
      }
      if (result.targetRoot) {
        const label = document.querySelector('#sophon-target-dir');
        if (label) label.textContent = result.targetRoot;
      }
      const free = Number(result.freeBytes) || 0;
      const base = Number(result.baseBytes) || 0;
      sumFree.textContent = free ? `${formatSize(free)}（${result.drive || '目标盘'}）` : '读不到磁盘信息';
      sumReuse.textContent = base
        ? `约 ${formatSize(base)}${result.partial ? '（还在统计）' : ''}`
        : '没有可复用的基础客户端';
      if (!free) {
        sumSpace.textContent = '判断不了，先按默认目录继续也可以';
      } else if (!base) {
        sumSpace.textContent = '没有基础客户端，全部要下载';
        sumSpace.classList.add('is-warn');
      } else if (base > free) {
        // 硬链接只是省掉「内容相同」的那部分，不能承诺一定装得下
        sumSpace.textContent = '可能不够：基础客户端比剩余空间大，相同文件会复用，仍建议先腾些空间';
        sumSpace.classList.add('is-warn');
      } else {
        sumSpace.textContent = '够用';
        sumSpace.classList.add('is-ok');
      }
      // 上一次可能因为缺基础客户端被拦住，条件补齐后要把按钮还回去
      if (errorBox) errorBox.textContent = '';
      restoreStart();
    } catch (error) {
      /*
       * estimate 遇到「没有基础客户端」「运行时目录不在同一个盘」这类硬性条件会直接抛错，
       * 那不是「读不到空间」，而是根本装不了 —— 原文透出，别糊成一句「直接开始也可以」。
       */
      sumReuse.textContent = '未知';
      sumFree.textContent = '未知';
      sumSpace.textContent = humanError(error);
      sumSpace.classList.add('is-warn');
      if (errorBox) errorBox.textContent = humanError(error);
      if (!running && !finishedOk) {
        start.disabled = true;
        start.textContent = '先按提示处理再开始';
      }
    }
  };
  refreshEstimate();

  const closeX = document.querySelector('.modal-head [data-close]');
  if (closeX) {
    closeX.addEventListener(
      'click',
      (event) => {
        if (running) {
          event.preventDefault();
          event.stopPropagation();
          minimizeTask();
        }
      },
      true
    );
  }
  const pickDir = document.querySelector('#sophon-pick-dir');
  if (pickDir) {
    pickDir.addEventListener('click', async () => {
      const dir = await api.pick.directory();
      if (!dir) return;
      selectedRuntimeRoot = dir;
      // 选的是「运行时根目录」，真正的客户端目录是 根目录\游戏\渠道，由主进程补全，
      // 所以这里先显示占位，等预估回来再写真实路径
      const label = document.querySelector('#sophon-target-dir');
      if (label) label.textContent = `${dir}（根目录，正在确定子目录…）`;
      // 换了目标盘，剩余空间就变了，预估得跟着重算
      refreshEstimate();
    });
  }
  pause.addEventListener('click', async () => {
    paused = !paused;
    await api.servers.pauseSophon({ jobId, paused }).catch(() => {});
    pause.textContent = paused ? '继续' : '暂停';
    const phase = document.querySelector('#sophon-phase');
    if (phase) phase.textContent = paused ? '已暂停（点继续恢复）' : '恢复中…';
    if (paused) updateDock('已暂停', 0, '点任务条恢复窗口');
  });

  start.addEventListener('click', async () => {
    // 跑完之后这个按钮变成「完成」：只负责关窗并放行队列里的下一个任务
    if (finishedOk) {
      closeModal();
      return;
    }
    running = true;
    cancelled = false;
    job.status = 'running';
    activeSophonJob = job;
    sophonUi = {
      restore: () => {
        if (backdrop) backdrop.style.display = '';
        document.body.classList.add('modal-open');
        document.body.classList.remove('sophon-minimized');
        renderTaskDock();
      },
      cancel: () => {
        cancelled = true;
        running = false;
        job.status = 'cancelled';
        api.servers.cancelSophon(jobId).catch(() => {});
        closeModal();
        hideDock();
        startNextSophonJob();
      },
    };
    renderTaskDock();
    start.disabled = true;
    start.textContent = '正在生成…';
    cancel.style.display = '';
    minimize.style.display = '';
    pause.style.display = '';
    progress.style.display = 'block';
    errorBox.textContent = '';
    paintStages(0);
    unsubscribe = api.onSophonProgress((event) => {
      if (event.jobId !== jobId) return;
      const total = Number(event.total) || 0;
      const processed = Number(event.processed) || 0;
      const percent = total ? Math.min(100, (processed / total) * 100) : 0;
      const stage = SOPHON_PHASE_STAGE[event.phase] ?? 2;
      const phases = {
        start: '读取官方清单',
        version: `目标版本 ${event.tag || ''}`,
        manifest: '读取清单与分块索引',
        install: '写入文件',
        download: '下载分块',
        patch: '应用补丁',
        // ldiff 预修补阶段：先把能就地补的文件补掉，再进 chunk 校验，界面上要能看出这一步在干什么
        ldiff: '本地补丁修补（省流）',
        link: '硬链接复用文件',
        pack: '下载渠道差异包',
        done: '完成',
      };
      // 目标版本一读出来就填进结论卡，别让用户猜这次要装哪个版本
      if (event.tag && sumTag) sumTag.textContent = event.tag;
      if (event.phase === 'ldiff') {
        ldiffSeen = true;
        if (ldiffLine) {
          ldiffLine.hidden = false;
          ldiffLine.textContent = sophonProgressStats(event);
        }
      }
      // 文件都写完了但还没收到 done，说明在收尾校验，阶段条前进一格
      paintStages(percent >= 100 && stage === 2 ? 3 : stage);
      document.querySelector('#sophon-phase').textContent = phases[event.phase] || '处理中…';
      document.querySelector('#sophon-count').textContent = total ? `${processed} / ${total}` : '';
      document.querySelector('#sophon-bar').style.width = `${event.phase === 'done' ? 100 : percent}%`;
      const stats = sophonProgressStats(event);
      document.querySelector('#sophon-stats').textContent = stats;
      document.querySelector('#sophon-current').textContent = event.current || '';
      updateDock(
        phases[event.phase] || '处理中…',
        event.phase === 'done' ? 100 : percent,
        sophonProgressStats(event, true),
        event.current || '',
        stage
      );
    });

    try {
      const result = await (isUpdate
        ? api.servers.updateSophon({ gameId, serverId, jobId })
        : api.servers.prepareSophon({
            gameId,
            serverId,
            jobId,
            runtimeRoot: selectedRuntimeRoot || undefined,
          }));
      if (result.cancelled || cancelled) {
        // 停了就是停了：坞里不留残影，免得左下角一直挂着一条什么都没有的条目
        job.status = 'cancelled';
        sophonJobs = sophonJobs.filter((item) => item !== job);
        hideDock();
        toast('已停止生成，可以下次继续', 'info');
        return;
      }
      running = false;
      job.status = 'done';
      job.percent = 100;
      // 任务结束就从坞里摘掉：坞只负责「还在跑的」，结果这一屏本来就在前台开着，
      // 再挂一条「已完成」只会一直赖在那个角落
      sophonJobs = sophonJobs.filter((item) => item !== job);
      hideDock();
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      /*
       * 完成后不自动关窗：这一屏里有「省了多少、哪些文件没走补丁」，
       * 只发一条几秒就消失的 toast 等于让用户自己猜。改成留在弹窗里，
       * 用户点「完成」再关，关的时候才放行队列里的下一个任务。
       */
      finishedOk = true;
      paintStages(SOPHON_STAGES.length - 1);
      showResult(result);
      const ldiffNote =
        result.ldiff && result.ldiff.applied > 0
          ? `，其中 ${result.ldiff.applied} 个由本地补丁修好、省流 ${formatSize(result.ldiff.saveBytes || 0)}`
          : '';
      toast(
        `${isUpdate ? '更新' : '生成'}完成（${result.tag}）：硬链接 ${result.linked} 个 · 下载 ${result.downloaded} 个${ldiffNote}`,
        'success'
      );
    } catch (error) {
      job.status = cancelled ? 'cancelled' : 'error';
      // 失败 / 停止同样不在坞里留残影：错误就写在这一屏上，坞只放还在跑的任务
      sophonJobs = sophonJobs.filter((item) => item !== job);
      hideDock();
      if (cancelled) toast('已停止生成', 'info');
      else {
        errorBox.textContent = humanError(error);
        toast(humanError(error), 'error');
      }
      startNextSophonJob();
    } finally {
      running = false;
      hideDock();
      start.disabled = false;
      start.textContent = finishedOk ? '完成' : '重新尝试';
      cancel.style.display = 'none';
      minimize.style.display = 'none';
      pause.style.display = 'none';
      pause.textContent = '暂停';
      paused = false;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    }
  });

  cancel.addEventListener('click', () => {
    cancelled = true;
    cancel.disabled = true;
    api.servers.cancelSophon(jobId).catch(() => {});
  });

  if (options.autoStart) {
    setTimeout(() => start.click(), 180);
  }
}

/** 两个服务器是否共用同一个安装目录（官服/B服 常见）。 */
function sameRoot(a, b) {
  if (!a || !b) return false;
  const left = String(a.root || '').replace(/[\\/]+$/, '').toLowerCase();
  const right = String(b.root || '').replace(/[\\/]+$/, '').toLowerCase();
  return Boolean(left) && left === right;
}

function openLinkModal(gameId) {
  const game = state.games.find((item) => item.id === gameId);
  if (!game) return;
  const servers = game.servers || [];
  const usable = servers.filter((server) => server.exists);
  /*
   * 这里不再拿「至少两个已配置的服务器」当门槛。
   * 玩家没有官服客户端、但本机有完整游戏目录时，靠自定义文件夹照样能合并；
   * 以前那种「还需要两个客户端」的空状态会把人直接挡在门外。
   */
  const option = (server) =>
    `<option value="${esc(server.id)}">${esc(server.name)}${
      server.exists ? '' : ' · 未配置启动程序'
    }</option>`;
  const defaultSource = usable.find((server) => server.active) || usable[0] || servers[0] || null;
  /*
   * 官服和 B 服常常装在同一目录（只是启动程序不同），这种组合压根没法建硬链接。
   * 默认目标优先挑一个目录不同的，免得用户一打开就撞上「源目录和目标目录相同」。
   */
  const defaultTarget =
    servers.find(
      (server) =>
        server.id !== (defaultSource && defaultSource.id) &&
        server.exists &&
        !sameRoot(server, defaultSource)
    ) ||
    servers.find((server) => server.id !== (defaultSource && defaultSource.id)) ||
    null;

  const html = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal sw-link-modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h2>硬链接去重</h2>
            <p>${esc(game.name)} · 把两个客户端里完全相同的文件合成同一份，不多删、不改内容。</p>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          ${
            servers.length
              ? `<ol class="sw-steps" id="sw-link-steps">
                  <li class="sw-step is-active"><span>1</span><strong>选对象</strong></li>
                  <li class="sw-step"><span>2</span><strong>预检</strong></li>
                  <li class="sw-step"><span>3</span><strong>执行</strong></li>
                </ol>
                <p class="sw-note">${icon(
                  'alert',
                  'xs'
                )}<span>开工前关掉游戏和官方启动器。只合并两边<b>大小和内容都相同</b>的文件；内容不同、目标端独有、游戏存档都不会被改动。</span></p>
                <details class="sw-note-more">
                  <summary>注意</summary>
                  <p>终末地的 <code>U8Data</code> 与 <code>sdkdata</code> 存的是渠道登录态，会自动跳过——合并了会让一边登录改写另一边的配置。第一次用建议选「完整校验」，确认没问题后再用快速比较。</p>
                </details>
                <section class="sw-link-step" id="link-step-1">
                  <div class="link-pair">
                    <div class="field" style="margin-bottom:0">
                      <label>源客户端（文件从这里复用）</label>
                      <select class="select" id="link-source" style="width:100%">${servers
                        .map(option)
                        .join('')}</select>
                    </div>
                    <button type="button" class="link-swap" id="link-swap" title="交换源和目标" aria-label="交换源和目标">${icon(
                      'shuffle'
                    )}</button>
                    <div class="field" style="margin-bottom:0">
                      <label>目标客户端（被合并的一方）</label>
                      <select class="select" id="link-target" style="width:100%">${servers
                        .map(option)
                        .join('')}</select>
                    </div>
                  </div>
                  <p class="sw-link-dirs" id="link-dirs" hidden></p>
                  <p class="sw-link-same" id="link-same" hidden></p>
                  <div class="sw-link-custom">
                    <div class="sw-link-custom-head">自定义文件夹（可选）· 没有对应渠道的 exe 也能用</div>
                    <div class="field-row">
                      <div class="field" style="margin-bottom:0">
                        <label>源目录</label>
                        <div class="input-group">
                          <input id="link-source-root" placeholder="留空则用源客户端的安装目录" spellcheck="false" />
                          <button type="button" class="btn btn-ghost" id="pick-link-source-root">${icon(
                            'folder'
                          )}浏览</button>
                        </div>
                      </div>
                      <div class="field" style="margin-bottom:0">
                        <label>目标目录</label>
                        <div class="input-group">
                          <input id="link-target-root" placeholder="留空则用目标客户端的安装目录" spellcheck="false" />
                          <button type="button" class="btn btn-ghost" id="pick-link-target-root">${icon(
                            'folder'
                          )}浏览</button>
                        </div>
                      </div>
                    </div>
                    <p class="hint">两个目录要么都填、要么都留空。填了就只比较这两个文件夹，不再要求服务器配好 exe。</p>
                  </div>
                  <div class="field">
                    <label>比对方式</label>
                    <div class="mode-options">
                      <label class="mode-card">
                        <input type="radio" name="link-mode" value="full" checked />
                        <span><strong>完整校验</strong><small>逐文件比对 SHA-256，最可靠；大客户端会慢一些。</small></span>
                      </label>
                      <label class="mode-card">
                        <input type="radio" name="link-mode" value="fast" />
                        <span><strong>快速比较</strong><small>大小 + 首尾各 1MB，快很多，适合先试跑。</small></span>
                      </label>
                    </div>
                  </div>
                </section>
                <section class="sw-link-step" id="link-step-2" hidden>
                  <div class="link-preview" id="link-preview" style="display:none"></div>
                </section>
                <section class="sw-link-step" id="link-step-3" hidden>
                  <div class="sw-result" id="link-result" hidden></div>
                </section>
                <div class="link-progress" id="link-progress" style="display:none">
                  <div class="link-progress-head">
                    <strong id="link-phase">准备中…</strong>
                    <span id="link-count"></span>
                  </div>
                  <div class="progress-bar"><span id="link-bar" style="width:0%"></span></div>
                  <div class="link-progress-meta">
                    <span id="link-saved"></span>
                    <span id="link-current"></span>
                  </div>
                </div>
                <div class="field-error" id="link-error"></div>`
              : `<div class="empty" style="padding:38px 20px">
                  <div class="empty-icon">${icon('link')}</div>
                  <h3>这个游戏还没有服务器</h3>
                  <p>先去服务器管理里添加一个客户端；如果你只是想让两个目录合并，也可以先添加任意一个再回来用自定义文件夹。</p>
                  <button class="btn btn-ghost" data-close>知道了</button>
                </div>`
          }
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" id="link-back" style="display:none">上一步</button>
          <button class="btn btn-ghost" data-close>关闭</button>
          ${
            servers.length
              ? `<button class="btn btn-ghost" id="link-cancel" style="display:none">停止</button>
                 <button class="btn btn-primary" id="link-start">${icon('search')}下一步：预检</button>`
              : ''
          }
        </div>
      </div>
    </div>`;

  let step = 1;
  let running = false;
  // 预检和真正的合共用同一个进度区，靠这个标记区分事件归属
  let previewing = false;
  // 两步流程：先检测出可合并的文件，用户确认后才真的建链接
  let previewResult = null;
  let currentJobId = null;
  let merged = false;
  let unsubProgress = null;
  let unsubPreview = null;

  openModal(html, {
    onClose: () => {
      if (unsubProgress) unsubProgress();
      if (unsubPreview) unsubPreview();
      if (running && currentJobId) api.servers.cancelLink(currentJobId).catch(() => {});
    },
  });

  if (!servers.length) return;

  const sourceSelect = document.querySelector('#link-source');
  const targetSelect = document.querySelector('#link-target');
  const startButton = document.querySelector('#link-start');
  const cancelButton = document.querySelector('#link-cancel');
  const progress = document.querySelector('#link-progress');
  const phase = document.querySelector('#link-phase');
  const count = document.querySelector('#link-count');
  const bar = document.querySelector('#link-bar');
  const saved = document.querySelector('#link-saved');
  const current = document.querySelector('#link-current');
  const error = document.querySelector('#link-error');
  const previewBox = document.querySelector('#link-preview');
  const resultBox = document.querySelector('#link-result');
  const sameNote = document.querySelector('#link-same');
  const dirsNote = document.querySelector('#link-dirs');
  const backButton = document.querySelector('#link-back');
  const stepNodes = [1, 2, 3].map((index) => document.querySelector(`#link-step-${index}`));
  const stepDots = [...document.querySelectorAll('#sw-link-steps .sw-step')];
  const linkSourceRoot = document.querySelector('#link-source-root');
  const linkTargetRoot = document.querySelector('#link-target-root');

  if (defaultSource) sourceSelect.value = defaultSource.id;
  if (defaultTarget) targetSelect.value = defaultTarget.id;

  const modeOf = () => document.querySelector('input[name="link-mode"]:checked').value;

  /* 路径比较统一走「正斜杠转反斜杠 + 去尾斜杠 + 小写」，否则 G:/X 和 G:\X\ 会被当成两个目录 */
  const normalizeDir = (dir) =>
    String(dir || '')
      .replace(/\//g, '\\')
      .replace(/\\+$/, '')
      .trim()
      .toLowerCase();
  const driveOf = (dir) => {
    const matched = String(dir || '')
      .replace(/\//g, '\\')
      .match(/^([a-zA-Z]):/);
    return matched ? matched[1].toUpperCase() : '';
  };

  /*
   * 第一步就在本地判一次能不能合并。
   *
   * 以前是点到最后一步才由后端抛「源目录和目标目录相同」，用户要重来一遍；
   * 官服和 B 服装在同一文件夹又是最常见的情况，所以这里当场说清楚并禁用下一步。
   */
  function checkDirs() {
    const customSource = linkSourceRoot.value.trim();
    const customTarget = linkTargetRoot.value.trim();
    const source = servers.find((item) => item.id === sourceSelect.value) || null;
    const target = servers.find((item) => item.id === targetSelect.value) || null;

    if (customSource || customTarget) {
      if (!customSource || !customTarget) {
        return { problem: '自定义文件夹需要同时指定源目录和目标目录。' };
      }
      if (normalizeDir(customSource) === normalizeDir(customTarget)) {
        return { problem: '源目录和目标目录填的是同一个文件夹，没有可合并的内容。' };
      }
      if (driveOf(customSource) && driveOf(customTarget) && driveOf(customSource) !== driveOf(customTarget)) {
        return { problem: '两个目录不在同一个磁盘分区，Windows 无法创建硬链接。' };
      }
      return { ok: true, custom: true, sourceRoot: customSource, targetRoot: customTarget, source, target };
    }

    if (!source || !target) return { problem: '请选择源客户端和目标客户端。' };
    if (source.id === target.id) {
      // 只有一行服务器的游戏（自建游戏常见）拿自己和自己比没有意义，直接把人引到自定义文件夹
      return {
        problem:
          servers.length < 2
            ? '这个游戏只有一行服务器，没法拿它和自己比。请在下面「自定义文件夹」里分别填源目录和目标目录。'
            : '源客户端和目标客户端不能是同一个。',
      };
    }
    const missing = [source, target].find((item) => !item.exists);
    if (missing) {
      return {
        problem: `${missing.name} 还没有配置启动程序（.exe）。可以先去服务器管理里选好，或者直接在下面的「自定义文件夹」里填两个完整目录。`,
      };
    }
    if (!source.root || !target.root) {
      return { problem: '读不到安装目录，请在「自定义文件夹」里手动填两个目录。' };
    }
    if (normalizeDir(source.root) === normalizeDir(target.root)) {
      return {
        problem:
          '这两个客户端装在同一个文件夹里（官服和 B 服常常是这样），没有可合并的内容。换一个目录不同的客户端，或者在下面「自定义文件夹」里分别填两个目录。',
      };
    }
    if (driveOf(source.root) !== driveOf(target.root)) {
      return { problem: '两个目录不在同一个磁盘分区，Windows 无法创建硬链接。' };
    }
    return { ok: true, custom: false, sourceRoot: source.root, targetRoot: target.root, source, target };
  }

  /* 第一步的实时反馈：能合并就把两个真实目录摊开给用户看，不能就说明原因并禁用下一步 */
  function paintStep1() {
    if (!startButton) return;
    const check = checkDirs();
    if (dirsNote) {
      dirsNote.hidden = !check.ok;
      dirsNote.textContent = check.ok ? `将比较：${check.sourceRoot} → ${check.targetRoot}` : '';
    }
    if (sameNote) {
      sameNote.hidden = Boolean(check.ok);
      sameNote.textContent = check.ok ? '' : check.problem;
    }
    if (step === 1) {
      startButton.disabled = !check.ok;
      startButton.textContent = '下一步：预检';
    }
    return check;
  }

  function paintStep() {
    stepNodes.forEach((node, index) => {
      if (node) node.hidden = index + 1 !== step;
    });
    stepDots.forEach((node, index) => {
      node.classList.toggle('is-active', index + 1 === step);
      node.classList.toggle('is-done', index + 1 < step);
      node.querySelector('span').textContent = index + 1 < step ? '✓' : String(index + 1);
    });
    if (backButton) backButton.style.display = step > 1 && !running && !merged ? '' : 'none';
    if (step === 1) {
      paintStep1();
    } else if (step === 2) {
      startButton.disabled = running || !previewResult || !previewResult.matchable;
      startButton.textContent =
        previewResult && previewResult.matchable
          ? `开始合并（省 ${fmtBytes(previewResult.matchableBytes || 0)}）`
          : '重新预检';
    } else {
      startButton.disabled = running;
      startButton.textContent = merged ? '完成' : '正在合并…';
    }
  }

  /* 交换源 / 目标：常用操作，别让用户把两个下拉各点一遍 */
  document.querySelector('#link-swap').addEventListener('click', () => {
    if (running) return;
    const sourceId = sourceSelect.value;
    sourceSelect.value = targetSelect.value;
    targetSelect.value = sourceId;
    const sourceDir = linkSourceRoot.value;
    linkSourceRoot.value = linkTargetRoot.value;
    linkTargetRoot.value = sourceDir;
    resetPreview();
    paintStep1();
  });

  function setProgress(p) {
    progress.style.display = 'block';
    const percent = p.total > 0 ? Math.min(100, (p.processed / p.total) * 100) : 0;
    bar.style.width = `${p.phase === 'done' ? 100 : percent}%`;
    count.textContent = p.total > 0 ? `${p.processed} / ${p.total} 个候选` : '';
    saved.textContent = `已合并 ${p.linked || 0} 个 · 节省 ${fmtBytes(p.savedBytes || 0)}`;
    current.textContent = p.current || '';
    if (p.phase === 'scan') phase.textContent = '正在扫描两个目录…';
    else if (p.phase === 'compare') phase.textContent = '正在比对文件内容…';
    else if (p.phase === 'link') phase.textContent = '正在建立硬链接…';
    else if (p.phase === 'done') phase.textContent = p.cancelled ? '已停止' : '正在收尾…';
  }

  unsubProgress = api.onLinkProgress((payload) => {
    // 预检和合并共用同一个进度区，previewing 期间不能让合并事件串进来
    if (!payload || payload.gameId !== gameId || previewing) return;
    if (running) {
      currentJobId = payload.jobId || currentJobId;
      cancelButton.style.display = '';
    }
    setProgress(payload);
  });

  /* 每个游戏各自记住上次选的自定义目录，下次打开自动填回 */
  const linkRootsKey = `vela:link-roots:${gameId}`;
  try {
    const savedRoots = JSON.parse(localStorage.getItem(linkRootsKey) || 'null');
    if (savedRoots && typeof savedRoots === 'object') {
      if (savedRoots.source) linkSourceRoot.value = savedRoots.source;
      if (savedRoots.target) linkTargetRoot.value = savedRoots.target;
    }
  } catch {
    /* optional recollection */
  }

  function rememberLinkRoots() {
    try {
      localStorage.setItem(
        linkRootsKey,
        JSON.stringify({
          source: linkSourceRoot.value.trim(),
          target: linkTargetRoot.value.trim(),
        })
      );
    } catch {
      /* optional recollection */
    }
  }

  document.querySelector('#pick-link-source-root').addEventListener('click', async () => {
    const picked = await api.pick.directory();
    if (picked) {
      linkSourceRoot.value = picked;
      resetPreview();
      paintStep1();
    }
  });
  document.querySelector('#pick-link-target-root').addEventListener('click', async () => {
    const picked = await api.pick.directory();
    if (picked) {
      linkTargetRoot.value = picked;
      resetPreview();
      paintStep1();
    }
  });

  /* 预检结果：先说人话（能合并多少、省多少、哪些不动），再看数字 */
  function renderPreview(result, mode) {
    // 几百 MB 摊在 100 多 GB 上四舍五入就成了 0%，显示「<1%」比「0%」诚实
    const raw = result.targetBytes ? (result.matchableBytes / result.targetBytes) * 100 : 0;
    const percent = raw > 0 && raw < 1 ? '<1' : Math.round(raw);
    previewBox.innerHTML = `
      <div class="link-preview-head">
        <strong>预检完成</strong>
        <span>${mode === 'fast' ? '快速比较' : '完整校验'}</span>
      </div>
      <p class="sw-preview-line">
        完全相同的文件 <b>${result.matchable || 0}</b> 个可以合并，省下约 <b>${fmtBytes(
          result.matchableBytes || 0
        )}</b>；内容不同的 <b>${result.different || 0}</b> 个、只在目标端存在的 <b>${
          result.targetOnly || 0
        }</b> 个会原样保留。
      </p>
      <div class="link-preview-grid">
        <div class="link-stat is-accent">
          <span class="link-stat-num">${fmtBytes(result.matchableBytes || 0)}</span>
          <span class="link-stat-label">可以合并 · ${result.matchable || 0} 个文件</span>
        </div>
        <div class="link-stat">
          <span class="link-stat-num">${fmtBytes(result.alreadyLinkedBytes || 0)}</span>
          <span class="link-stat-label">已经合并过 · ${result.alreadyLinked || 0} 个</span>
        </div>
        <div class="link-stat">
          <span class="link-stat-num">${fmtBytes(result.differentBytes || 0)}</span>
          <span class="link-stat-label">内容不同（不动）· ${result.different || 0} 个</span>
        </div>
        <div class="link-stat">
          <span class="link-stat-num">${fmtBytes(result.targetOnlyBytes || 0)}</span>
          <span class="link-stat-label">目标端独有（保留）· ${result.targetOnly || 0} 个</span>
        </div>
      </div>
      <p class="link-preview-note">目标目录共 ${fmtBytes(result.targetBytes || 0)}，合并后大约省下 ${percent}%。</p>
    `;
    previewBox.style.display = 'block';
  }

  /* 换了源/目标/比对方式，之前的预检结果就作废，得重新检一遍 */
  function resetPreview() {
    previewResult = null;
    previewBox.style.display = 'none';
    previewBox.innerHTML = '';
    if (resultBox) resultBox.hidden = true;
  }

  [sourceSelect, targetSelect].forEach((select) =>
    select.addEventListener('change', () => {
      if (running) return;
      resetPreview();
      paintStep1();
    })
  );
  document.querySelectorAll('input[name="link-mode"]').forEach((input) =>
    input.addEventListener('change', () => {
      if (running) return;
      resetPreview();
      paintStep1();
    })
  );
  [linkSourceRoot, linkTargetRoot].forEach((input) =>
    input.addEventListener('input', () => {
      if (running) return;
      resetPreview();
      paintStep1();
    })
  );

  unsubPreview = api.onLinkPreviewProgress((payload) => {
    if (!payload || payload.gameId !== gameId || !previewing) return;
    currentJobId = payload.jobId || currentJobId;
    progress.style.display = 'block';
    const percent = payload.total > 0 ? Math.min(100, (payload.processed / payload.total) * 100) : 0;
    bar.style.width = `${percent}%`;
    phase.textContent = payload.phase === 'scan' ? '正在扫描两个目录…' : '正在比对文件内容…';
    count.textContent = payload.total > 0 ? `${payload.processed} / ${payload.total} 个候选` : '';
    saved.textContent = `已找到 ${payload.matchable || 0} 个可合并 · ${fmtBytes(payload.matchableBytes || 0)}`;
    current.textContent = payload.current || '';
  });

  /*
   * 后端约定：sourceRoot / targetRoot 要么同时给、要么同时不给。
   * 只给一个会被直接抛「自定义文件夹需要同时指定源目录和目标目录」，
   * 所以这里按 check.custom 统一决定传还是传空串。
   */
  function buildPayload(check) {
    return {
      gameId,
      sourceId: sourceSelect.value,
      targetId: targetSelect.value,
      mode: modeOf(),
      sourceRoot: check.custom ? check.sourceRoot : '',
      targetRoot: check.custom ? check.targetRoot : '',
    };
  }

  /* 第 2 步：只读检测，不改任何文件 */
  async function runPreview(check) {
    running = true;
    previewing = true;
    error.textContent = '';
    progress.style.display = 'block';
    bar.style.width = '0%';
    count.textContent = '';
    saved.textContent = '';
    current.textContent = '';
    phase.textContent = '正在准备…';
    cancelButton.style.display = '';
    cancelButton.disabled = false;
    startButton.disabled = true;
    startButton.textContent = '正在预检…';
    try {
      const result = await api.servers.linkPreview(buildPayload(check));
      currentJobId = result.jobId || currentJobId;
      if (result.cancelled) {
        phase.textContent = '已停止预检';
        startButton.disabled = false;
        startButton.textContent = '重新预检';
        return;
      }
      previewResult = result;
      renderPreview(result, modeOf());
      progress.style.display = 'none';
      if (!result.matchable) {
        startButton.disabled = true;
        startButton.textContent = '没有可合并的文件';
        error.textContent =
          '这两个目录里没有内容完全相同的文件：要么之前已经合并过，要么两边的文件都不一样。换一组目录再试。';
        return;
      }
      startButton.disabled = false;
      startButton.textContent = `开始合并（省 ${fmtBytes(result.matchableBytes || 0)}）`;
      toast(`预检完成：可合并 ${result.matchable} 个文件`, 'info');
    } catch (err) {
      // 后端的中文错误原样透出（同盘校验、启动程序不存在、目录相同……），不自己改写成模糊说法
      error.textContent = humanError(err);
      phase.textContent = '预检没完成';
      startButton.disabled = false;
      startButton.textContent = '重新预检';
    } finally {
      running = false;
      previewing = false;
      currentJobId = null;
      cancelButton.style.display = 'none';
    }
  }

  function showLinkResult(result, cancelled) {
    if (!resultBox) return;
    resultBox.hidden = false;
    resultBox.innerHTML = `
      <strong class="sw-result-title">${cancelled ? '已停止合并' : '合并完成'}</strong>
      <div class="sw-result-grid">
        <div class="sw-result-item"><span>合并文件</span><strong>${result.linked || 0} 个</strong></div>
        <div class="sw-result-item"><span>节省空间</span><strong>${fmtBytes(result.savedBytes || 0)}</strong></div>
        <div class="sw-result-item"><span>跳过</span><strong>${result.skipped || 0} 个</strong></div>
      </div>
      <p class="sw-result-note">检查了 ${result.total || 0} 个候选${
        result.errors && result.errors.length
          ? `；${result.errors.length} 个文件被占用或读取失败，已跳过`
          : ''
      }。${cancelled ? '已经合并的文件保持合并状态，不会回退。' : '两边的游戏存档和不同文件都没有改动。'}</p>`;
  }

  /* 第 3 步：真的建立硬链接 */
  async function runLink() {
    const check = checkDirs();
    if (!check.ok) {
      error.textContent = check.problem;
      return;
    }
    running = true;
    merged = false;
    error.textContent = '';
    progress.style.display = 'block';
    bar.style.width = '0%';
    count.textContent = '';
    saved.textContent = '';
    current.textContent = '';
    phase.textContent = '正在准备…';
    cancelButton.style.display = '';
    cancelButton.disabled = false;
    startButton.disabled = true;
    startButton.textContent = '正在合并…';
    try {
      const result = await api.servers.link(buildPayload(check));
      merged = true;
      showLinkResult(result, Boolean(result.cancelled));
      startButton.disabled = false;
      startButton.textContent = '完成';
      if (result.cancelled) {
        toast('已停止合并，已经合并的文件保持不变', 'info');
      } else {
        toast(`合并完成：${result.linked || 0} 个文件，省下 ${fmtBytes(result.savedBytes || 0)}`, 'success');
      }
    } catch (err) {
      error.textContent = humanError(err);
      phase.textContent = '合并没能完成';
      startButton.disabled = false;
      startButton.textContent = '重试合并';
    } finally {
      running = false;
      currentJobId = null;
      cancelButton.style.display = 'none';
      // 失败时保留「上一步」，让用户回去改目录或换客户端，而不是只剩一个重试按钮
      if (merged && backButton) backButton.style.display = 'none';
    }
  }

  startButton.addEventListener('click', async () => {
    if (step === 1) {
      const check = checkDirs();
      if (!check.ok) {
        error.textContent = check.problem;
        paintStep1();
        return;
      }
      error.textContent = '';
      rememberLinkRoots();
      previewResult = null;
      resetPreview();
      step = 2;
      paintStep();
      await runPreview(check);
      return;
    }
    if (step === 2) {
      if (running) return;
      const check = checkDirs();
      if (!check.ok) {
        error.textContent = check.problem;
        step = 1;
        paintStep();
        return;
      }
      if (!previewResult || !previewResult.matchable) {
        await runPreview(check);
        return;
      }
      step = 3;
      paintStep();
      await runLink();
      return;
    }
    if (step === 3) {
      if (running) return;
      // 失败后停在第三步，按钮是「重试合并」，别把它当成「完成」直接关窗
      if (!merged) {
        await runLink();
        return;
      }
      closeModal();
    }
  });

  if (backButton) {
    backButton.addEventListener('click', () => {
      if (running || merged) return;
      step = 1;
      error.textContent = '';
      progress.style.display = 'none';
      resetPreview();
      paintStep();
    });
  }

  cancelButton.addEventListener('click', async () => {
    if (!currentJobId) return;
    cancelButton.disabled = true;
    phase.textContent = '正在停止…';
    await api.servers.cancelLink(currentJobId).catch(() => {});
    cancelButton.disabled = false;
  });

  paintStep();
}

function openNewsModal(id) {
  const post = state.news.find((item) => item.id === id);
  if (!post) return;
  const body = (post.body || [])
    .map((line, index) => {
      if (line.startsWith('## ')) return `<h3>${esc(line.slice(3))}</h3>`;
      return `<p class="${index === 0 ? 'lead' : ''}">${esc(line)}</p>`;
    })
    .join('');
  const html = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal article" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <div class="eyebrow" style="margin-bottom:8px">${esc(post.tag)}</div>
            <h2>${esc(post.title)}</h2>
          </div>
          <button class="modal-close" data-close title="关闭">${icon('x')}</button>
        </div>
        <div class="article-body">
          <div class="meta">
            <span>${formatDate(post.date)}</span>
            <span style="width:2px;height:2px;border-radius:50%;background:currentColor"></span>
            <span>${esc(post.readTime || '')}</span>
          </div>
          ${newsFigure(post)}
          ${body}
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" data-close>关闭</button>
        </div>
      </div>
    </div>`;
  openModal(html);
}
