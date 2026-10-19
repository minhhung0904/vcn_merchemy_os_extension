// content/flow-modal.js
// Shared UI for the "Push to Flow Studio" action, loaded on both Etsy and
// Shopify before etsy.js/shopify.js (same isolated world per frame), so both
// platform scripts can call window.__sellfernFlow without duplicating markup
// or styling.

(function () {
  'use strict';

  if (window.__sellfernFlow) return;

  // ─── Button injection helper ──────────────────────────────────────────────

  function injectButton(container, { label = 'Push to Flow Studio', onClick, title } = {}) {
    if (!container) return null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    if (title) btn.title = title;
    btn.setAttribute('data-sellfern-flow-btn', '1');
    Object.assign(btn.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '4px 10px',
      margin: '0 4px',
      fontSize: '12px',
      fontWeight: '600',
      lineHeight: '1.4',
      color: '#ffffff',
      background: '#5b4fe9',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      whiteSpace: 'nowrap',
      zIndex: '2147483000',
    });
    btn.addEventListener('mouseenter', () => { btn.style.background = '#473dc9'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#5b4fe9'; });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick?.(e);
    });
    container.appendChild(btn);
    return btn;
  }

  // ─── Modal ─────────────────────────────────────────────────────────────────

  function closeModal(host) {
    host.remove();
    document.removeEventListener('keydown', host.__onKeyDown);
  }

  function openPushModal({ orderId, platform, storeName, customText, products, suggestedTitle }) {
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
        .backdrop { position: fixed; inset: 0; background: rgba(15, 15, 20, 0.5); display: flex; align-items: center; justify-content: center; font-family: system-ui, -apple-system, sans-serif; }
        .card { width: 420px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); overflow: auto; background: #fff; border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,0.3); padding: 20px; }
        h2 { margin: 0 0 4px; font-size: 16px; color: #16181d; }
        .sub { margin: 0 0 16px; font-size: 12px; color: #6b7280; }
        label { display: block; font-size: 12px; font-weight: 600; color: #374151; margin: 12px 0 4px; }
        select, input[type=text] { width: 100%; box-sizing: border-box; padding: 7px 8px; font-size: 13px; border: 1px solid #d1d5db; border-radius: 6px; color: #111827; }
        .preview { max-height: 90px; overflow: auto; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px; font-size: 12px; color: #374151; white-space: pre-wrap; }
        .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
        button { font-family: inherit; font-size: 13px; font-weight: 600; border-radius: 6px; padding: 7px 14px; cursor: pointer; border: none; }
        .btn-cancel { background: #f3f4f6; color: #374151; }
        .btn-submit { background: #5b4fe9; color: #fff; }
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
              ? products.map((p) => escapeHtml(p)).join('<br/>')
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
        boardId, columnId, title, orderId, platform, storeName, customText, products,
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
