// content/shopify.js
// Isolated-world content script for Shopify's unified admin (admin.shopify.com).
//
// Unlike content/etsy.js, this script never constructs the order-list request
// URL itself — Shopify's admin API uses "persisted queries" identified by a
// hash tied to whatever frontend build is currently deployed, which can
// change on any Shopify redeploy with no notice. Instead, content/shopify-main.js
// (running in the page's own MAIN world) passively captures the exact
// URL/hash the live page is using right now for the "OrderListData"
// operation and relays it here via window.postMessage. This script then
// reuses that same (currently-valid) template to fetch additional pages.
//
// KNOWN LIMITATION: the OrderListData operation is Shopify's *order index
// table* query. It has not been confirmed (only live-tested with a 2-order
// store) whether it includes full line-item detail (SKU/variant/price per
// item) the way the Etsy Mission Control API does. mapLineItems() below
// degrades gracefully to a single synthetic item (using the aggregate
// quantity/total) when per-item data isn't present — this needs to be
// verified against real data and refined.

(function () {
  'use strict';

  if (window.__sellfernShopifyLoaded) return;
  window.__sellfernShopifyLoaded = true;

  // ─── State: latest captured OrderListData template ───────────────────────

  let capturedTemplate = null; // { base, variables, firstPage }
  const nodeCache = new Map(); // orderId -> raw order node, seen across any page we've fetched

  function cacheNodes(edges) {
    (edges || []).forEach((e) => {
      const node = e.node || e;
      if (node?.id) nodeCache.set(gidToId(node.id), node);
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || !data.__sellfern) return;

    if (data.type === 'ORDER_LIST_TEMPLATE') {
      capturedTemplate = data.payload;
      cacheNodes(capturedTemplate?.firstPage?.edges);
      console.log('[Sellfern] Captured a live OrderListData template.', capturedTemplate?.base);
    }
  });

  // ─── Shop handle detection ────────────────────────────────────────────────

  function getShopHandle() {
    const m = window.location.href.match(/\/store\/([^/]+)\//);
    return m ? m[1] : null;
  }

  // ─── Fetch one page using the captured template ──────────────────────────

  async function fetchOrderListPage(template, variablesOverride) {
    const variables = { ...(template.variables || {}), ...variablesOverride };
    const url = `${template.base}?operationName=OrderListData&variables=${encodeURIComponent(JSON.stringify(variables))}`;
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      console.error('[Sellfern][Shopify] Page fetch failed:', res.status, res.statusText, url.slice(0, 300));
      throw new Error(`Shopify internal API error ${res.status}`);
    }
    const json = await res.json();
    if (!json?.data?.ordersList) {
      console.error('[Sellfern][Shopify] Unexpected OrderListData shape:', {
        topKeys: Object.keys(json || {}),
        dataKeys: Object.keys(json?.data || {}),
        errors: json?.errors,
      });
      throw new Error('Unexpected OrderListData response shape.');
    }
    return json.data.ordersList;
  }

  // ─── Aggregate all pages ──────────────────────────────────────────────────

  async function fetchAllOrders(onProgress) {
    console.log('[Sellfern][Shopify] fetchAllOrders start. template captured =', !!capturedTemplate, 'url =', location.href);
    if (!capturedTemplate) {
      throw new Error(
        'No live Shopify order query captured yet. Please open/reload this store\'s Orders page ' +
        '(admin.shopify.com/store/<handle>/orders) once, let it fully load, then try again.'
      );
    }

    const template = capturedTemplate;
    const nodes = [];
    let page = template.firstPage;
    let guard = 0;

    while (page) {
      const edges = page.edges || [];
      cacheNodes(edges);
      nodes.push(...edges.map((e) => e.node));
      onProgress?.(nodes.length);

      const pageInfo = page.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) break;
      if (++guard > 200) break; // safety cap

      page = await fetchOrderListPage(template, { after: pageInfo.endCursor, before: null });
    }

    return nodes;
  }

  // ─── Map Shopify order node → Sellfern Order/OrderItem ────────────────────

  function gidToId(gid) {
    if (!gid) return '';
    const m = String(gid).match(/\/(\d+)$/);
    return m ? m[1] : String(gid);
  }

  function mapLineItems(node, orderCtx) {
    // NOTE: not yet confirmed whether OrderListData includes a `lineItems`
    // connection. Read defensively; fall back to one synthetic row so the
    // order still carries its total/quantity if per-item detail is absent.
    const edges = node.lineItems?.edges || node.lineItems?.nodes?.map((n) => ({ node: n })) || [];

    if (!mapLineItems.logged) {
      mapLineItems.logged = true;
      console.log('[Sellfern][Shopify] Order node keys:', Object.keys(node));
      console.log('[Sellfern][Shopify] First line item raw:', JSON.stringify(edges[0]?.node ?? null, null, 2));
    }

    if (!edges.length) {
      return [{
        id: orderCtx.orderId,
        name: node.name || 'Shopify order',
        sku: '',
        quantity: node.currentSubtotalLineItemsQuantity || 1,
        price: orderCtx.totalAmount,
        variations: '',
        personalization: '',
        ...orderCtx,
        status: orderCtx.fulfillmentStatus,
      }];
    }

    return edges.map(({ node: li }) => ({
      id: gidToId(li.id),
      name: li.title || li.name || 'Unknown product',
      sku: li.sku || li.variant?.sku || '',
      quantity: li.quantity || 1,
      price: Number(li.originalUnitPriceSet?.shopMoney?.amount ?? li.discountedUnitPriceSet?.shopMoney?.amount ?? 0),
      variations: li.variantTitle || li.variant?.title || '',
      imageUrl: li.image?.url || li.image?.src || li.variant?.image?.url || li.product?.featuredImage?.url || '',
      personalization: '',
      ...orderCtx,
      status: orderCtx.fulfillmentStatus,
    }));
  }

  function mapOrder(node, storeName) {
    const orderId = gidToId(node.id);
    const money = node.currentTotalPriceSet?.shopMoney || {};
    const addr = node.shippingAddress || {};

    const customerName = addr.name || node.email || 'Unknown Buyer';
    const customerAddress = [addr.address1, addr.address2, addr.city, addr.provinceCode || addr.province, addr.zip, addr.countryCodeV2 || addr.country]
      .filter(Boolean).join(', ');

    const orderCtx = {
      orderId,
      orderDate: node.createdAt || node.processedAt || new Date().toISOString(),
      storeName: storeName || '',
      customerName,
      customerAddress,
      shipName: addr.name || customerName,
      shipAddress1: addr.address1 || '',
      shipAddress2: addr.address2 || '',
      shipCity: addr.city || '',
      shipState: addr.provinceCode || addr.province || '',
      shipZipcode: addr.zip || '',
      shipCountry: addr.countryCodeV2 || addr.country || '',
      phone: addr.phone || '',
      totalAmount: Number(money.amount || 0),
      fulfillmentStatus: node.displayFulfillmentStatus || '',
    };

    const items = mapLineItems(node, orderCtx);

    return {
      id: orderId,
      platform: 'shopify',
      storeName: storeName || '',
      date: orderCtx.orderDate,
      items,

      totalAmount: Number(money.amount || 0),
      subtotal: Number(money.amount || 0),
      discount: 0,
      tax: 0,
      shippingCost: 0,
      currency: money.currencyCode || 'USD',

      isRefunded: node.displayFinancialStatus === 'REFUNDED' || node.displayFinancialStatus === 'PARTIALLY_REFUNDED',
      isCaseClosed: false,
      isLost: false,
      isGift: '',

      customerName,
      customerEmail: node.email || '',
      customerAddress,
      shipAddress1: orderCtx.shipAddress1,
      shipAddress2: orderCtx.shipAddress2,
      shipCity: orderCtx.shipCity,
      shipState: orderCtx.shipState,
      shipZipcode: orderCtx.shipZipcode,
      shipCountry: orderCtx.shipCountry,

      couponCode: '',
      paymentMethod: node.displayFinancialStatus || '',
      orderUrl: `https://admin.shopify.com/store/${window.__sellfernShopHandle || ''}/orders/${orderId}`,

      // Extra Shopify-only context, harmless if backend ignores it
      orderName: node.name || '',
      financialStatus: node.displayFinancialStatus || '',
      fulfillmentStatus: node.displayFulfillmentStatus || '',
      tags: node.tags || [],
    };
  }

  // ─── Main message handler ─────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_SHOPIFY_HANDLE') {
      sendResponse({ ok: true, handle: getShopHandle() });
      return true;
    }

    if (message.type === 'SCRAPE_SHOPIFY_ORDERS') {
      window.__sellfernShopHandle = message.shopHandle || getShopHandle();
      handleScrape(message, sendResponse);
      return true; // async
    }
  });

  // Shopify's saved-view tabs (Open/Unfulfilled/Closed…) filter server-side via
  // a `savedViewId` GID that's instantiated per-store — there's no stable ID we
  // could hardcode across merchants. Instead, we fetch whatever the default
  // view returns (same as today) and filter client-side, mirroring the same
  // 3 filter categories Shopify's own Orders page exposes (Order status /
  // Payment status / Fulfillment status), using fields already present on
  // every order node.

  // Order status isn't a single field — Shopify derives it from `closed` +
  // `cancelledAt`, same as the "status" filter choices (open/closed/cancelled).
  function deriveOrderStatus(n) {
    if (n.cancelledAt) return 'CANCELLED';
    return n.closed ? 'CLOSED' : 'OPEN';
  }

  function filterNodes(nodes, filters = {}) {
    const { orderStatus, financialStatus, fulfillmentStatus } = filters;
    return nodes.filter((n) => {
      if (orderStatus && orderStatus !== 'any' && deriveOrderStatus(n) !== orderStatus) return false;
      if (financialStatus && financialStatus !== 'any' && n.displayFinancialStatus !== financialStatus) return false;
      if (fulfillmentStatus && fulfillmentStatus !== 'any' && n.displayFulfillmentStatus !== fulfillmentStatus) return false;
      return true;
    });
  }

  async function handleScrape(message, sendResponse) {
    try {
      const nodes = await fetchAllOrders((fetched) => {
        chrome.runtime.sendMessage({ type: 'FETCH_PROGRESS', fetched, total: fetched }).catch(() => {});
      });

      const filtered = filterNodes(nodes, message.filters);
      console.log('[Sellfern][Shopify] Scrape result:', {
        fetched: nodes.length,
        afterFilter: filtered.length,
        filters: message.filters,
        storeName: message.storeName,
        sampleStatuses: nodes.slice(0, 5).map((n) => [n.displayFinancialStatus, n.displayFulfillmentStatus, deriveOrderStatus(n)]),
      });
      const orders = filtered.map((n) => mapOrder(n, message.storeName));

      sendResponse({ ok: true, orders, count: orders.length, total: orders.length });
    } catch (err) {
      console.error('[Sellfern][Shopify] Scrape failed:', err);
      sendResponse({ ok: false, error: err.message });
    }
  }

  // ─── Flow Studio: "Push to Flow Studio" button injection ───────────────────
  // Shopify's admin order table rows are more structurally predictable than
  // Etsy's (Polaris <table>/<tr> with a primary <a href=".../orders/<id>">),
  // but this has not been live-verified this round either — selectors are
  // centralized here for a quick fix if the console.warn below fires.

  const FLOW_SELECTORS_SHOPIFY = {
    orderLinkPattern: /\/orders\/(\d+)(?:[/?]|$)/,
  };

  function isOrdersPage() {
    return /\/orders(\/|$|\?)/.test(location.pathname);
  }

  function getDetailOrderId() {
    const m = location.pathname.match(/\/orders\/(\d+)(?:\/|$)/);
    return m ? m[1] : null;
  }

  function findOrderRows() {
    const rows = new Set();
    document.querySelectorAll('a[href*="/orders/"]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(FLOW_SELECTORS_SHOPIFY.orderLinkPattern);
      if (!m) return;
      const row = a.closest('tr') || a.closest('[role="row"]');
      if (row) rows.add(row);
    });
    return Array.from(rows);
  }

  async function findOrderNodeById(orderId) {
    const cached = nodeCache.get(String(orderId));
    if (cached) return cached;
    if (!capturedTemplate) {
      throw new Error(
        'No live Shopify order query captured yet. Please reload this store\'s Orders page and try again.'
      );
    }

    let page = capturedTemplate.firstPage;
    let guard = 0;
    while (page) {
      const edges = page.edges || [];
      cacheNodes(edges);
      const found = edges.map((e) => e.node).find((n) => gidToId(n.id) === String(orderId));
      if (found) return found;

      const pageInfo = page.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) break;
      if (++guard > 20) break; // bounded search, mirrors fetchAllOrders' own safety cap
      page = await fetchOrderListPage(capturedTemplate, { after: pageInfo.endCursor, before: null });
    }
    return nodeCache.get(String(orderId)) || null;
  }

  async function handlePushOrderToFlowShopify(orderId) {
    try {
      const node = await findOrderNodeById(orderId);
      if (!node) throw new Error('Could not find this order in the captured order list. Try reloading the Orders page.');

      // Taken from the admin URL so Flow Studio doesn't depend on the
      // order-sync store mapping (shopifyStoreName).
      const storeName = (location.pathname.match(/\/store\/([^/]+)/) || [])[1] || '';
      // Best effort: Shopify order nodes carry no scraped personalization
      // field today (mapLineItems hardcodes it blank) — fall back to the
      // order's own note, if the captured query happens to include it.
      const customText = node.note || '';

      const money = node.currentTotalPriceSet?.shopMoney || {};
      const items = mapLineItems(node, {
        orderId,
        totalAmount: Number(money.amount || 0),
        fulfillmentStatus: node.displayFulfillmentStatus || '',
      });
      const products = items.map((item) => {
        const lines = [`${item.quantity || 1}x ${item.name || 'Unknown product'}`];
        if (item.imageUrl) lines.push(`Image: ${item.imageUrl}`);
        if (item.sku) lines.push(`SKU: ${item.sku}`);
        if (item.variations) lines.push(item.variations);
        return lines.join('\n');
      });

      window.__sellfernFlow.openPushModal({
        orderId,
        platform: 'shopify',
        storeName,
        customText,
        products,
        titlePrefix: node.name || `#${orderId}`,
      });
    } catch (err) {
      console.error('[Sellfern] Failed to prepare Flow Studio push:', err);
      window.__sellfernFlow.showError(
        window.__sellfernFlow.describePushError(err),
        { title: 'Could not load order' }
      );
    }
  }

  function injectDetailButton(orderId) {
    if (document.querySelector('[data-sellfern-detail-injected]')) return;
    const marker = document.createElement('span');
    marker.setAttribute('data-sellfern-detail-injected', '1');
    marker.style.display = 'inline-block';

    const header = document.querySelector('h1')?.closest('div');
    if (header) {
      header.appendChild(marker);
    } else {
      Object.assign(marker.style, { position: 'fixed', bottom: '24px', right: '24px', zIndex: '2147483000' });
      document.body.appendChild(marker);
    }

    window.__sellfernFlow.injectButton(marker, {
      label: 'Push to Flow Studio',
      title: 'Create a Flow Studio card for this order',
      onClick: () => handlePushOrderToFlowShopify(orderId),
    });
  }

  let flowScanWarnedShopify = false;

  function scanAndInjectShopifyButtons() {
    if (!window.__sellfernFlow || !isOrdersPage()) return;

    const detailId = getDetailOrderId();
    if (detailId) {
      injectDetailButton(detailId);
      return;
    }

    const rows = findOrderRows();
    if (!rows.length) {
      if (!flowScanWarnedShopify) {
        console.warn(
          '[Sellfern] Could not find any order rows to attach "Push to Flow Studio" buttons. ' +
          'FLOW_SELECTORS_SHOPIFY in content/shopify.js may need updating for this Shopify layout.'
        );
        flowScanWarnedShopify = true;
      }
      return;
    }

    rows.forEach((row) => {
      if (row.hasAttribute('data-sellfern-injected')) return;
      const link = row.querySelector('a[href*="/orders/"]');
      const m = link && (link.getAttribute('href') || '').match(FLOW_SELECTORS_SHOPIFY.orderLinkPattern);
      if (!m) return;
      const orderId = m[1];
      row.setAttribute('data-sellfern-injected', '1');

      const container = document.createElement('span');
      container.style.display = 'inline-block';
      row.appendChild(container);

      window.__sellfernFlow.injectButton(container, {
        label: 'Push to Flow Studio',
        title: 'Create a Flow Studio card for this order',
        onClick: () => handlePushOrderToFlowShopify(orderId),
      });
    });
  }

  function initFlowButtonInjector() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', initFlowButtonInjector, { once: true });
      return;
    }
    const observer = new MutationObserver(() => scanAndInjectShopifyButtons());
    observer.observe(document.body, { childList: true, subtree: true });
    scanAndInjectShopifyButtons();
  }

  initFlowButtonInjector();

  console.log('[Sellfern] Shopify unified-admin connector loaded.');
})();
