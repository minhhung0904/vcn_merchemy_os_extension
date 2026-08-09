// content/shopify-main.js
// Runs in the PAGE's own JS context (world: "MAIN"), because Shopify's unified
// admin (admin.shopify.com) is a React SPA that calls its own internal,
// undocumented "persisted query" API — a plain content script (isolated
// world) has its own separate `window`/`fetch` and would never see the SPA's
// real network calls.
//
// Strategy: instead of hardcoding the persisted-query hash (it's tied to
// whatever frontend build Shopify currently has deployed, and changes on
// every admin redeploy with no notice), we passively capture whichever hash
// the live page is *actually* using right now for the "OrderListData"
// operation, and hand that template over to content/shopify.js (isolated
// world, has chrome.* API access) so it can fire additional paginated
// requests using that same, currently-valid hash.

(function () {
  if (window.__sellfernShopifyMainInstalled) return;
  window.__sellfernShopifyMainInstalled = true;

  function post(type, payload) {
    try {
      window.postMessage({ __sellfern: true, type, payload }, '*');
    } catch (_) {}
  }

  function tryCaptureOrderListData(url, jsonText) {
    if (!/operationName=OrderListData/.test(url)) return;
    let json;
    try {
      json = JSON.parse(jsonText);
    } catch (_) {
      return;
    }
    if (!json?.data?.ordersList) return;

    let variables = null;
    try {
      const u = new URL(url);
      const raw = u.searchParams.get('variables');
      if (raw) variables = JSON.parse(raw);
    } catch (_) {}

    // Split off the "…/OrderListData/shopify/{handle}" part so shopify.js can
    // rebuild a URL with new `variables` without needing to know the hash format.
    const base = url.split('?')[0];

    post('ORDER_LIST_TEMPLATE', {
      base,
      variables,
      firstPage: json.data.ordersList,
    });
  }

  // ─── Patch fetch ────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const res = await origFetch.apply(this, arguments);

    if (url.includes('/api/operations/') && url.includes('OrderListData')) {
      try {
        const text = await res.clone().text();
        tryCaptureOrderListData(url, text);
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
    if (url.includes('/api/operations/') && url.includes('OrderListData')) {
      this.addEventListener('loadend', () => {
        tryCaptureOrderListData(url, this.responseText || '');
      });
    }
    return origSend.apply(this, arguments);
  };

  console.log('[Sellfern] Shopify OrderListData sniffer installed.');
})();
