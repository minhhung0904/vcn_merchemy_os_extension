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

  function openPushModal({ orderId, platform, storeName, customText, products, suggestedTitle, attachmentUrls }) {
    // Avoid stacking multiple modals if clicked twice.
    document.getElementById('__sellfern-flow-modal-host')?.remove();

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
        .card { width: 420px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); overflow: auto; background: #fff; border-radius: 14px; box-shadow: 0 20px 50px rgba(15,23,42,0.35); padding: 20px; }
        h2 { margin: 0 0 4px; font-size: 16px; color: #16181d; }
        .sub { margin: 0 0 16px; font-size: 12px; color: #6b7280; }
        label { display: block; font-size: 12px; font-weight: 600; color: #374151; margin: 12px 0 4px; }
        select, input[type=text] { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 13px; border: 1px solid #cbd5e1; border-radius: 8px; color: #111827; }
        .preview { max-height: 90px; overflow: auto; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px; font-size: 12px; color: #374151; white-space: pre-wrap; }
        .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
        button { font-family: inherit; font-size: 13px; font-weight: 600; border-radius: 999px; padding: 8px 18px; cursor: pointer; border: none; }
        .btn-cancel { background: #f1f5f9; color: #475569; }
        .btn-submit { background: linear-gradient(180deg, #14b8a6, #0d9488); color: #fff; }
        .btn-submit:disabled { opacity: 0.6; cursor: default; }
        .status { margin-top: 10px; font-size: 12px; }
        .status.error { color: #dc2626; }
        .status.success { color: #16a34a; }
        .close { position: absolute; top: 14px; right: 16px; background: none; color: #9ca3af; font-size: 18px; padding: 0; line-height: 1; }
      </style>
      <div class="backdrop">
        <div class="card" style="position: relative;">
          <button class="close" data-action="close">&times;</button>
          <h2>Push to Flow Studio</h2>
          <p class="sub">Order #${escapeHtml(orderId || '')}${storeName ? ' · ' + escapeHtml(storeName) : ''}</p>

          <label>Board</label>
          <select data-field="board"><option>Loading boards…</option></select>

          <label>Column</label>
          <select data-field="column"><option>Select a board first</option></select>

          <label>Card title</label>
          <input type="text" data-field="title" value="${escapeHtml(suggestedTitle || '')}" />

          <label>Products</label>
          <div class="preview">${
            (products && products.length)
              ? products.map((p) => linkify(p)).join('<br/>')
              : '<em>No product details found for this order.</em>'
          }</div>

          <label>Custom Text (personalization)</label>
          <div class="preview">${escapeHtml(customText) || '<em>No personalization text found for this order.</em>'}</div>

          <div class="status" data-field="status"></div>

          <div class="actions">
            <button class="btn-cancel" data-action="close">Cancel</button>
            <button class="btn-submit" data-action="submit">Create card</button>
          </div>
        </div>
      </div>
    `;

    const boardSelect = root.querySelector('[data-field="board"]');
    const columnSelect = root.querySelector('[data-field="column"]');
    const titleInput = root.querySelector('[data-field="title"]');
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

    // Load boards.
    chrome.runtime.sendMessage({ type: 'GET_FLOW_BOARDS' }, (res) => {
      if (chrome.runtime.lastError) {
        boardSelect.innerHTML = '<option>Failed to load boards</option>';
        setStatus(chrome.runtime.lastError.message, 'error');
        return;
      }
      if (!res?.ok) {
        boardSelect.innerHTML = '<option>Failed to load boards</option>';
        setStatus(res?.error || 'Failed to load boards.', 'error');
        return;
      }
      const boards = res.boards || [];
      if (!boards.length) {
        boardSelect.innerHTML = '<option value="">No boards found</option>';
        return;
      }
      boardSelect.innerHTML = boards
        .map((b) => `<option value="${b.id}">${escapeHtml(b.title || 'Untitled board')}</option>`)
        .join('');
      loadColumnsForBoard(boardSelect.value);
    });

    boardSelect.addEventListener('change', () => loadColumnsForBoard(boardSelect.value));

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
      const boardId = boardSelect.value;
      const columnId = columnSelect.value;
      const title = titleInput.value;

      if (!boardId) return setStatus('Please choose a board.', 'error');
      if (!columnId) return setStatus('Please choose a column.', 'error');
      if (!title.trim()) return setStatus('Please enter a card title.', 'error');

      submitBtn.disabled = true;
      setStatus('Creating card…');

      chrome.runtime.sendMessage({
        type: 'CREATE_FLOW_CARD',
        boardId, columnId, title, orderId, platform, storeName, customText, products, attachmentUrls,
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

  window.__sellfernFlow = { injectButton, openPushModal };
})();
