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

  function tryCaptureOrdersData(url, jsonText) {
    if (!/\/mission-control\/orders\/data(?:\?|$)/.test(url)) return;
    let json;
    try {
      json = JSON.parse(jsonText);
    } catch (_) {
      return;
    }
    const search = json?.orders_search || json?.ordersSearch;
    if (!search) return;
    post('ORDERS_DATA_PAGE', {
      orders: search.orders || [],
      buyers: search.buyers || [],
    });
  }

  function logReq(method, url) {
    try {
      if (!url || !/\/api\//.test(url)) return;
      console.log('[Sellfern][Etsy network]', method || 'GET', url);
    } catch (_) {}
  }

  // ─── Patch fetch ────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const method = init?.method || (typeof input !== 'string' && input?.method) || 'GET';
    const url = typeof input === 'string' ? input : input?.url || '';
    logReq(method, url);
    const res = await origFetch.apply(this, arguments);

    if (/\/mission-control\/orders\/data(?:\?|$)/.test(url)) {
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
    logReq(method, url);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__sellfernUrl || '';
    if (/\/mission-control\/orders\/data(?:\?|$)/.test(url)) {
      this.addEventListener('loadend', () => {
        tryCaptureOrdersData(url, this.responseText || '');
      });
    }
    return origSend.apply(this, arguments);
  };

  console.log('[Sellfern] Etsy orders-data sniffer installed.');
})();
