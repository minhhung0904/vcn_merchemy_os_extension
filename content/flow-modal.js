// content/flow-modal.js
// Shared UI for the "Push to Flow Studio" action, loaded on both Etsy and
// Shopify before etsy.js/shopify.js (same isolated world per frame), so both
// platform scripts can call window.__sellfernFlow without duplicating markup
// or styling.

(function () {
  'use strict';

  if (window.__sellfernFlow) return;

  // ─── Button injection helper ──────────────────────────────────────────────

  // Rendered inside a shadow root so Etsy/Shopify page CSS can't restyle it.
  // Look follows the Sellfern popup: teal gradient pill, Inter, brand mark.
  function injectButton(container, { label = 'Push to Flow Studio', onClick, title } = {}) {
    if (!container) return null;

    let iconUrl = '';
    try { iconUrl = chrome.runtime.getURL('icons/icon32.png'); } catch (_) {}

    const host = document.createElement('span');
    host.setAttribute('data-sellfern-flow-btn', '1');
    host.style.display = 'inline-block';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        button {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 9px 16px 9px 10px;
          font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
          font-size: 13px; font-weight: 600; line-height: 1; letter-spacing: 0.01em;
          color: #fff; white-space: nowrap; cursor: pointer;
          background: linear-gradient(180deg, #14b8a6, #0d9488);
          border: 1px solid rgba(255, 255, 255, 0.25);
          border-radius: 999px;
          box-shadow: 0 6px 18px rgba(13, 148, 136, 0.35), 0 1px 2px rgba(0, 0, 0, 0.15);
          transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
        }
        button:hover {
          background: linear-gradient(180deg, #2dd4bf, #0d9488);
          box-shadow: 0 8px 22px rgba(13, 148, 136, 0.45), 0 1px 2px rgba(0, 0, 0, 0.15);
          transform: translateY(-1px);
        }
        button:active { transform: translateY(0); box-shadow: 0 3px 10px rgba(13, 148, 136, 0.35); }
        button:focus-visible { outline: 2px solid #99f6e4; outline-offset: 2px; }
        button:disabled { cursor: progress; opacity: 0.85; transform: none; background: linear-gradient(180deg, #14b8a6, #0d9488); }
        .spinner {
          display: none; width: 14px; height: 14px; flex: none;
          border: 2px solid rgba(255, 255, 255, 0.35); border-top-color: #fff;
          border-radius: 50%; animation: spin 0.7s linear infinite;
        }
        button.loading .spinner { display: block; }
        button.loading .arrow { display: none; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .mark {
          width: 22px; height: 22px; border-radius: 50%; background: #fff;
          display: inline-flex; align-items: center; justify-content: center; flex: none;
        }
        .mark img { width: 16px; height: 16px; display: block; }
        .arrow { width: 14px; height: 14px; flex: none; }
      </style>
      <button type="button">
        ${iconUrl ? `<span class="mark"><img src="${iconUrl}" alt="" /></span>` : ''}
        <span class="label"></span>
        <span class="spinner"></span>
        <svg class="arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="M12 5l7 7-7 7"></path></svg>
      </button>
    `;
    const btn = root.querySelector('button');
    root.querySelector('.label').textContent = label;
    if (title) btn.title = title;
    const labelEl = root.querySelector('.label');
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;
      // Show a busy state while the handler (returns a promise) is working,
      // so the click visibly registers and can't be double-fired.
      btn.disabled = true;
      btn.classList.add('loading');
      labelEl.textContent = 'Loading order…';
      try {
        await onClick?.(e);
      } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
        labelEl.textContent = label;
      }
    });
    container.appendChild(host);
    return host;
  }

  // ─── Modal ─────────────────────────────────────────────────────────────────

  function closeModal(host) {
    host.remove();
    document.removeEventListener('keydown', host.__onKeyDown);
  }

  const STORE_CODE_KEY = '__sellfern-flow-store-code';

  function readStoreCode(storeName) {
    try { return (JSON.parse(localStorage.getItem(STORE_CODE_KEY) || '{}'))[storeName || ''] || ''; }
    catch (_) { return ''; }
  }

  function saveStoreCode(storeName, code) {
    try {
      const all = JSON.parse(localStorage.getItem(STORE_CODE_KEY) || '{}');
      all[storeName || ''] = code;
      localStorage.setItem(STORE_CODE_KEY, JSON.stringify(all));
    } catch (_) { /* storage unavailable — code just won't be remembered */ }
  }

  // Same layout the card description is created with, so the textarea in the
  // modal is exactly what lands on the card.
  function buildDescription({ orderId, storeName, products, customText }) {
    const details = (products || []).map((p) => String(p)).filter(Boolean).join('\n\n');
    return [
      details,
      ...(customText ? [...(details ? [''] : []), 'Notes:', customText] : []),
    ].join('\n');
  }

  function openPushModal({ orderId, platform, storeName, customText, products, titlePrefix, attachments: attachmentList, attachmentUrls }) {
    // Avoid stacking multiple modals if clicked twice.
    document.getElementById('__sellfern-flow-modal-host')?.remove();

    let modalIconUrl = '';
    try { modalIconUrl = chrome.runtime.getURL('icons/icon48.png'); } catch (_) { /* no icon */ }

    titlePrefix = titlePrefix || `#${orderId || ''}`;
    // [{ url, name }] in display order; plain URL lists (Shopify) get no name.
    const attachmentItems = attachmentList || (attachmentUrls || []).map((url) => ({ url, name: '' }));
    const attachments = attachmentItems.map((a) => a.url);
    const attachmentNames = attachmentItems.map((a) => a.name);
    const savedStoreCode = readStoreCode(storeName);
    const descriptionText = buildDescription({ orderId, storeName, products, customText });

    const host = document.createElement('div');
    host.id = '__sellfern-flow-modal-host';
    Object.assign(host.style, {
      position: 'fixed', inset: '0', zIndex: '2147483647',
    });
    document.body.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .backdrop { position: fixed; inset: 0; background: rgba(15, 15, 20, 0.5); display: flex; align-items: center; justify-content: center; font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; }
        .card { width: 720px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); overflow: auto; background: #fbfcfd; border-radius: 16px; box-shadow: 0 20px 50px rgba(15,23,42,0.35); padding: 28px; }
        h2 { margin: 0 0 4px; font-size: 20px; color: #16181d; }
        .sub { margin: 0 0 20px; font-size: 14px; color: #4b5563; }
        label { display: block; font-size: 14px; font-weight: 600; color: #1f2937; margin: 16px 0 6px; }
        select, input[type=text] { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 15px; border: 1px solid #c3cad6; border-radius: 8px; color: #1e293b; background: #f5f7fa; }
        .preview { max-height: 160px; overflow: auto; background: #f5f7fa; border: 1px solid #d2d8e2; border-radius: 8px; padding: 10px 12px; font-size: 14px; color: #1f2937; white-space: pre-wrap; }
        .title { display: flex; align-items: center; gap: 10px; }
        .brand-icon { width: 30px; height: 30px; border-radius: 7px; flex: none; }
        .brand-name { color: #0d9488; }
        .combo { position: relative; }
        .combo-btn { width: 100%; box-sizing: border-box; text-align: left; border-radius: 8px; border: 1px solid #c3cad6; background: #f5f7fa; color: #1e293b; padding: 10px 32px 10px 12px; font-size: 15px; font-weight: 400; position: relative; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .combo-btn::after { content: '▾'; position: absolute; right: 12px; top: 50%; transform: translateY(-50%); color: #4b5563; }
        .combo-panel { position: absolute; z-index: 10; left: 0; right: 0; top: calc(100% + 4px); background: #f5f7fa; border: 1px solid #c3cad6; border-radius: 10px; box-shadow: 0 10px 28px rgba(15,23,42,0.22); padding: 8px; }
        .combo-panel[hidden] { display: none; }
        .combo-list { max-height: 240px; overflow: auto; margin-top: 6px; }
        .combo-item { padding: 9px 10px; font-size: 15px; color: #111827; border-radius: 6px; cursor: pointer; }
        .combo-item:hover { background: #e4e8ee; }
        .combo-item.selected { background: #ccfbf1; font-weight: 600; }
        .combo-empty { padding: 9px 10px; font-size: 14px; color: #4b5563; }
        .title-row { display: flex; align-items: center; gap: 8px; }
        .title-prefix { font-size: 15px; font-weight: 600; color: #111827; white-space: nowrap; }
        .hint { margin-top: 6px; font-size: 13px; color: #4b5563; }
        textarea { width: 100%; box-sizing: border-box; padding: 10px 12px; font-family: inherit; font-size: 14px; line-height: 1.5; min-height: 260px; border: 1px solid #c3cad6; border-radius: 8px; color: #1e293b; background: #f5f7fa; resize: vertical; }
        .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
        button { font-family: inherit; font-size: 15px; font-weight: 600; border-radius: 999px; padding: 10px 24px; cursor: pointer; border: none; }
        .btn-cancel { background: #dde2ea; color: #475569; }
        .btn-submit { background: linear-gradient(180deg, #14b8a6, #0d9488); color: #fff; }
        .btn-submit:disabled { opacity: 0.6; cursor: default; }
        .status { margin-top: 12px; font-size: 14px; }
        .status.error { color: #dc2626; }
        .status.success { color: #16a34a; }
        .close { position: absolute; top: 16px; right: 20px; background: none; color: #9ca3af; font-size: 26px; padding: 0; line-height: 1; }
      </style>
      <div class="backdrop">
        <div class="card" style="position: relative;">
          <button class="close" data-action="close">&times;</button>
          <h2 class="title">
            ${modalIconUrl ? `<img class="brand-icon" src="${modalIconUrl}" alt="" />` : ''}
            <span>Push to Flow Studio <span class="brand-name">Sellfern</span></span>
          </h2>
          <p class="sub">Order #${escapeHtml(orderId || '')}${storeName ? ' · ' + escapeHtml(storeName) : ''}</p>

          <label>Board</label>
          <div class="combo">
            <button type="button" class="combo-btn" data-field="boardBtn">Loading boards…</button>
            <div class="combo-panel" data-field="boardPanel" hidden>
              <input type="text" data-field="boardSearch" placeholder="Search boards…" autocomplete="off" />
              <div class="combo-list" data-field="boardList"></div>
            </div>
          </div>

          <label>Column</label>
          <select data-field="column"><option>Select a board first</option></select>

          <label>Card title</label>
          <div class="title-row">
            <span class="title-prefix">${escapeHtml(titlePrefix)}</span>
            <input type="text" data-field="storeCode" placeholder="Store code (e.g. AZ)" value="${escapeHtml(savedStoreCode)}" />
          </div>
          <div class="hint">Card title: <b data-field="titlePreview"></b></div>

          <label>Description</label>
          <textarea data-field="description" rows="12">${escapeHtml(descriptionText)}</textarea>

          <label>Attachments${attachments.length ? ' (' + attachments.length + ')' : ''}</label>
          <div class="preview">${
            attachments.length
              ? attachmentItems.map((a, i) => `${i + 1}. ${a.name ? '<b>' + escapeHtml(a.name) + '</b>\n    ' : ''}${linkify(a.url)}`).join('\n')
              : '<em>No attachments found for this order.</em>'
          }</div>

          <div class="status" data-field="status"></div>

          <div class="actions">
            <button class="btn-cancel" data-action="close">Cancel</button>
            <button class="btn-submit" data-action="submit">Create card</button>
          </div>
        </div>
      </div>
    `;

    const boardBtn = root.querySelector('[data-field="boardBtn"]');
    const boardPanel = root.querySelector('[data-field="boardPanel"]');
    const boardList = root.querySelector('[data-field="boardList"]');
    let boardId = '';
    const columnSelect = root.querySelector('[data-field="column"]');
    const storeCodeInput = root.querySelector('[data-field="storeCode"]');
    const titlePreview = root.querySelector('[data-field="titlePreview"]');
    const descriptionInput = root.querySelector('[data-field="description"]');
    const buildTitle = () => `${titlePrefix}${storeCodeInput.value.trim()}`;
    const updateTitlePreview = () => { titlePreview.textContent = buildTitle(); };
    storeCodeInput.addEventListener('input', updateTitlePreview);
    updateTitlePreview();
    const statusEl = root.querySelector('[data-field="status"]');
    const submitBtn = root.querySelector('[data-action="submit"]');

    function setStatus(text, kind) {
      statusEl.textContent = text || '';
      statusEl.className = 'status' + (kind ? ' ' + kind : '');
    }

    root.querySelectorAll('[data-action="close"]').forEach((el) =>
      el.addEventListener('click', () => closeModal(host))
    );
    root.querySelector('.backdrop').addEventListener('click', (e) => {
      if (e.target.classList.contains('backdrop')) closeModal(host);
    });

    host.__onKeyDown = (e) => { if (e.key === 'Escape') closeModal(host); };
    document.addEventListener('keydown', host.__onKeyDown);

    const boardSearch = root.querySelector('[data-field="boardSearch"]');
    let allBoards = [];

    function renderBoardList() {
      const q = boardSearch.value.trim().toLowerCase();
      const shown = allBoards.filter((b) => !q || (b.title || '').toLowerCase().includes(q));
      boardList.innerHTML = shown.length
        ? shown.map((b) =>
            `<div class="combo-item${String(b.id) === String(boardId) ? ' selected' : ''}" data-id="${b.id}">${escapeHtml(b.title || 'Untitled board')}</div>`
          ).join('')
        : '<div class="combo-empty">No boards match</div>';
    }

    function selectBoard(id) {
      const board = allBoards.find((b) => String(b.id) === String(id));
      if (!board) return;
      const changed = String(id) !== String(boardId);
      boardId = board.id;
      boardBtn.textContent = board.title || 'Untitled board';
      if (changed) loadColumnsForBoard(id);
    }

    function closeBoardPanel() { boardPanel.hidden = true; }

    boardBtn.addEventListener('click', () => {
      if (!boardPanel.hidden) return closeBoardPanel();
      if (!allBoards.length) return;
      boardSearch.value = '';
      renderBoardList();
      boardPanel.hidden = false;
      boardSearch.focus();
    });
    boardSearch.addEventListener('input', renderBoardList);
    boardList.addEventListener('click', (e) => {
      const item = e.target.closest('.combo-item');
      if (!item) return;
      selectBoard(item.dataset.id);
      closeBoardPanel();
    });
    // Click anywhere else in the modal closes the list.
    root.addEventListener('click', (e) => {
      if (!e.target.closest('.combo')) closeBoardPanel();
    });

    // Load boards (the default board from Settings goes first when it exists).
    chrome.runtime.sendMessage({ type: 'GET_FLOW_BOARDS' }, async (res) => {
      if (chrome.runtime.lastError) {
        boardBtn.textContent = 'Failed to load boards';
        setStatus(chrome.runtime.lastError.message, 'error');
        return;
      }
      if (!res?.ok) {
        boardBtn.textContent = 'Failed to load boards';
        setStatus(res?.error || 'Failed to load boards.', 'error');
        return;
      }
      const boards = res.boards || [];
      if (!boards.length) {
        boardBtn.textContent = 'No boards found';
        return;
      }
      let defaultBoardId = '';
      try {
        defaultBoardId = (await chrome.storage.local.get(['flowDefaultBoardId'])).flowDefaultBoardId || '';
      } catch (_) { /* no default — list as-is */ }
      const defaultBoard = boards.find((b) => String(b.id) === String(defaultBoardId));
      allBoards = defaultBoard ? [defaultBoard, ...boards.filter((b) => b !== defaultBoard)] : boards;
      selectBoard(allBoards[0].id); // default board (if any) is first
    });

    function loadColumnsForBoard(boardId) {
      if (!boardId) return;
      columnSelect.innerHTML = '<option>Loading columns…</option>';
      chrome.runtime.sendMessage({ type: 'GET_FLOW_BOARD_DETAIL', boardId }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          columnSelect.innerHTML = '<option value="">Failed to load columns</option>';
          return;
        }
        const columns = (res.board?.columns || []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        if (!columns.length) {
          columnSelect.innerHTML = '<option value="">No columns on this board</option>';
          return;
        }
        columnSelect.innerHTML = columns
          .map((c) => `<option value="${c.id}">${escapeHtml(c.title || 'Untitled column')}</option>`)
          .join('');
      });
    }

    submitBtn.addEventListener('click', () => {
      const columnId = columnSelect.value;
      const title = buildTitle();

      if (!boardId) return setStatus('Please choose a board.', 'error');
      if (!columnId) return setStatus('Please choose a column.', 'error');

      saveStoreCode(storeName, storeCodeInput.value.trim());
      submitBtn.disabled = true;
      setStatus('Creating card…');

      chrome.runtime.sendMessage({
        type: 'CREATE_FLOW_CARD',
        boardId, columnId, title, orderId, platform, storeName, customText, products,
        description: descriptionInput.value, attachmentUrls: attachments, attachmentNames,
      }, (res) => {
        submitBtn.disabled = false;
        if (chrome.runtime.lastError || !res?.ok) {
          setStatus(res?.error || chrome.runtime.lastError?.message || 'Failed to create card.', 'error');
          return;
        }
        setStatus('Card created in Flow Studio.', 'success');
        setTimeout(() => closeModal(host), 1200);
      });
    });
  }

  // ─── Error messages ────────────────────────────────────────────────────────
  // Turns a caught error into a clear, actionable reason instead of dumping
  // its raw message (a bare TypeError, "Failed to fetch", a runtime-messaging
  // error, etc.) in front of the user. Unrecognized errors still get a
  // concrete next step, just without parroting the raw text — the raw error
  // is already in the console via the caller's console.error.
  function describePushError(err) {
    const msg = String(err?.message || err || '');

    if (/context invalidated/i.test(msg)) {
      return 'The Sellfern extension was updated or reloaded. Please refresh this page (F5) and try again.';
    }
    if (/could not establish connection|receiving end does not exist/i.test(msg)) {
      return 'The Sellfern extension did not respond in time. Please refresh this page (F5) and try again.';
    }
    if (/failed to fetch|networkerror|network request failed|load failed/i.test(msg)) {
      return "Could not reach the page's data — check your internet connection and try again.";
    }
    if (/not been loaded by the Orders page/i.test(msg)) {
      return msg;
    }
    if (/no flow studio api token/i.test(msg)) {
      return 'No Flow Studio API token is set. Open the extension Settings, add one under "Flow Studio API Token", then try again.';
    }
    if (/invalid or expired flow studio api token/i.test(msg)) {
      return 'Your Flow Studio API token is invalid or has expired. Update it in the extension Settings and try again.';
    }

    return "This order's details could not be read. Please reload the Orders page (F5) and try again — if it keeps happening, check the browser console for the underlying error.";
  }

  // ─── Error popup ───────────────────────────────────────────────────────────
  // Same card/backdrop look as the push modal, used instead of alert() so a
  // failure (e.g. the order didn't load) doesn't break out of the extension's
  // own styling into a bare browser dialog.

  function showError(message, { title = 'Something went wrong' } = {}) {
    document.getElementById('__sellfern-flow-error-host')?.remove();

    const host = document.createElement('div');
    host.id = '__sellfern-flow-error-host';
    Object.assign(host.style, {
      position: 'fixed', inset: '0', zIndex: '2147483647',
    });
    document.body.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .backdrop { position: fixed; inset: 0; background: rgba(15, 15, 20, 0.5); display: flex; align-items: center; justify-content: center; font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; }
        .card { width: 360px; max-width: calc(100vw - 32px); background: #fbfcfd; border-radius: 14px; box-shadow: 0 20px 50px rgba(15,23,42,0.35); padding: 20px; position: relative; }
        .icon { width: 36px; height: 36px; border-radius: 50%; background: #fef2f2; color: #dc2626; display: flex; align-items: center; justify-content: center; margin-bottom: 12px; }
        .icon svg { width: 20px; height: 20px; }
        h2 { margin: 0 0 6px; font-size: 15px; color: #16181d; }
        p.message { margin: 0; font-size: 13px; line-height: 1.5; color: #1f2937; white-space: pre-wrap; }
        .actions { display: flex; justify-content: flex-end; margin-top: 18px; }
        button { font-family: inherit; font-size: 13px; font-weight: 600; border-radius: 999px; padding: 8px 18px; cursor: pointer; border: none; }
        .btn-ok { background: linear-gradient(180deg, #14b8a6, #0d9488); color: #fff; }
        .close { position: absolute; top: 14px; right: 16px; background: none; color: #9ca3af; font-size: 18px; padding: 0; line-height: 1; border: none; cursor: pointer; }
      </style>
      <div class="backdrop">
        <div class="card">
          <button class="close" data-action="close">&times;</button>
          <div class="icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="13"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
          </div>
          <h2>${escapeHtml(title)}</h2>
          <p class="message">${escapeHtml(message)}</p>
          <div class="actions">
            <button class="btn-ok" data-action="close">OK</button>
          </div>
        </div>
      </div>
    `;

    root.querySelectorAll('[data-action="close"]').forEach((el) =>
      el.addEventListener('click', () => closeModal(host))
    );
    root.querySelector('.backdrop').addEventListener('click', (e) => {
      if (e.target.classList.contains('backdrop')) closeModal(host);
    });

    host.__onKeyDown = (e) => { if (e.key === 'Escape') closeModal(host); };
    document.addEventListener('keydown', host.__onKeyDown);

    return host;
  }

  // Escape, then turn http(s) URLs (e.g. the product image) into clickable links.
  function linkify(str) {
    return escapeHtml(str).replace(
      /https?:\/\/[^\s<]+/g,
      (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:#0d9488;">${url}</a>`
    );
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  window.__sellfernFlow = { injectButton, openPushModal, showError, describePushError };
})();
