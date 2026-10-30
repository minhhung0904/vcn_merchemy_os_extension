// content/etsy-main.js
// Runs in the PAGE's own JS context (world: "MAIN") so it can see the real
// network calls Etsy's own frontend makes — an isolated content script's
// fetch/XHR are separate copies that never see the host page's own requests
// (same reasoning as content/shopify-main.js for Shopify's admin).
//
// Etsy has no separate "get one order's detail" endpoint (confirmed live:
// opening an order's detail view only fires /orders/convos/<id> and
// /orders/earnings/<id>/details/all — never a core order-detail call). The
// order's full data (items, buyer note, address…) only ever comes from the
// orders *list* endpoint (mission-control/orders/data), which the page
// itself already calls when the Orders screen loads/paginates. So instead of
// content/etsy.js making its own extra request, this passively captures that
// response as the page fetches it and hands it over via postMessage — the
// isolated-world script can then look an order up from this cache with zero
// extra network calls, same idea as the OrderListData capture for Shopify.

(function () {
  if (window.__sellfernEtsyMainInstalled) return;
  window.__sellfernEtsyMainInstalled = true;

  function post(type, payload) {
    try {
      window.postMessage({ __sellfern: true, type, payload }, '*');
    } catch (_) {}
  }

  // The isolated-world script (etsy.js) loads at document_idle, usually AFTER
  // the page has already fetched its first orders list, so a one-shot
  // postMessage would be lost. Keep everything captured here and replay it on
  // request.
  const store = { orders: new Map(), buyers: new Map() };

  function replayAll() {
    if (store.orders.size || store.buyers.size) {
      post('ORDERS_DATA_PAGE', {
        orders: Array.from(store.orders.values()),
        buyers: Array.from(store.buyers.values()),
      });
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.__sellfern_request === 'REPLAY') replayAll();
  });

  // Any mission-control call except the per-order ones; tryCaptureOrdersData
  // only keeps responses that actually carry orders_search.orders, so a
  // renamed/variant list endpoint is still picked up.
  function isOrdersListUrl(url) {
    return /\/api\//.test(url) &&
      !/\/(?:personalization-files|convos|earnings)\//.test(url);
  }

  function tryCaptureOrdersData(url, jsonText) {
    if (!isOrdersListUrl(url)) return;
    let json;
    try {
      json = JSON.parse(jsonText);
    } catch (_) {
      return;
    }
    const search = json?.orders_search || json?.ordersSearch;
    if (!search) return;
    if (!Array.isArray(search.orders)) {
      return;
    }
    const orders = search.orders || [];
    const buyers = search.buyers || [];
    orders.forEach((o) => {
      const id = o.order_id ?? o.orderId ?? o.receipt_id ?? o.receiptId;
      if (id != null) store.orders.set(String(id), o);
    });
    buyers.forEach((b) => {
      const id = b.buyer_id ?? b.buyerId;
      if (id != null) store.buyers.set(String(id), b);
    });
    post('ORDERS_DATA_PAGE', { orders, buyers });
  }

  // ─── Patch fetch ────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const res = await origFetch.apply(this, arguments);

    if (isOrdersListUrl(url)) {
      try {
        const text = await res.clone().text();
        tryCaptureOrdersData(url, text);
      } catch (_) {}
    }
    return res;
  };

  // ─── Patch XHR (fallback, in case the SPA ever uses it for this call) ────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__sellfernUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__sellfernUrl || '';
    if (isOrdersListUrl(url)) {
      this.addEventListener('loadend', () => {
        tryCaptureOrdersData(url, this.responseText || '');
      });
    }
    return origSend.apply(this, arguments);
  };
})();
