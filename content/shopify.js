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

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || !data.__sellfern) return;

    if (data.type === 'ORDER_LIST_TEMPLATE') {
      capturedTemplate = data.payload;
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
    if (!res.ok) throw new Error(`Shopify internal API error ${res.status}`);
    const json = await res.json();
    if (!json?.data?.ordersList) throw new Error('Unexpected OrderListData response shape.');
    return json.data.ordersList;
  }

  // ─── Aggregate all pages ──────────────────────────────────────────────────

  async function fetchAllOrders(onProgress) {
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
      const orders = filtered.map((n) => mapOrder(n, message.storeName));

      sendResponse({ ok: true, orders, count: orders.length, total: orders.length });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  }

  console.log('[Sellfern] Shopify unified-admin connector loaded.');
})();
