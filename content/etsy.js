// content/etsy.js
// Fetches orders via Etsy's internal Mission Control API and maps them to the
// Merchemy OS Order / OrderItem structure.
// Since this script runs in the etsy.com context, all fetch calls are
// same-origin and carry the user's session cookies automatically.

(function () {
  'use strict';

  if (window.__merchemyEtsyScraperLoaded) return;
  window.__merchemyEtsyScraperLoaded = true;

  // ─── Constants ───────────────────────────────────────────────────────────────

  const MISSION_CONTROL_BASE =
    'https://www.etsy.com/api/v3/ajax/bespoke/shop';

  const DEFAULT_LIMIT = 50; // Etsy allows up to 100 per page
  const DEFAULT_ORDER_STATE = ''; // empty = all states

  // ─── Get Shop (Business) ID ───────────────────────────────────────────────────
  // Etsy embeds the shop ID in multiple places on the page.

  function getShopId() {
    // 1. Meta tag Etsy sometimes adds
    const metaShopId = document.querySelector('meta[name="shop-id"]');
    if (metaShopId?.content) return metaShopId.content;

    // 2. Look in page globals exposed via window.__reactPageGlobals or similar
    try {
      const globals = window.__reactPageGlobals || window.__page_globals || {};
      if (globals.shop_id) return String(globals.shop_id);
      if (globals.business_id) return String(globals.business_id);
    } catch (_) {}

    // 3. Try window.etsy / Etsy.Session
    try {
      if (window.etsy?.Session?.shopId) return String(window.etsy.Session.shopId);
    } catch (_) {}

    // 4. Scrape from any URL in the page that contains the mission-control path
    const mcLinks = Array.from(document.querySelectorAll('a[href*="mission-control"], script'))
      .map(el => el.href || el.src || el.textContent || '')
      .join(' ');
    const mcMatch = mcLinks.match(/\/shop\/(\d+)\//);
    if (mcMatch) return mcMatch[1];

    // 5. Try extracting from current URL (seller dashboard URLs contain shop id)
    const urlMatch = window.location.href.match(/\/shop\/(\d+)\//);
    if (urlMatch) return urlMatch[1];

    // 6. Parse inline JSON scripts for business_id or shop_id
    const scripts = document.querySelectorAll('script[type="application/json"], script:not([src])');
    for (const s of scripts) {
      const m = s.textContent.match(/"business_id"\s*:\s*(\d+)/);
      if (m) return m[1];
      const m2 = s.textContent.match(/"shop_id"\s*:\s*(\d+)/);
      if (m2) return m2[1];
    }

    return null;
  }

  // ─── Build API URL ────────────────────────────────────────────────────────────

  function buildApiUrl(shopId, offset = 0, limit = DEFAULT_LIMIT, orderStateId = '') {
    const params = new URLSearchParams({
      'filters[buyer_id]': 'all',
      'filters[channel]': 'all',
      'filters[completed_status]': 'all',
      'filters[completed_date]': 'all',
      'filters[destination]': 'all',
      'filters[ship_date]': 'all',
      'filters[shipping_label_eligibility]': 'false',
      'filters[shipping_label_status]': 'all',
      'filters[has_buyer_notes]': 'false',
      'filters[is_marked_as_gift]': 'false',
      'filters[is_personalized]': 'false',
      'filters[has_shipping_upgrade]': 'false',
      'filters[order_state_id]': orderStateId,
      limit: String(limit),
      offset: String(offset),
      search_terms: '',
      sort_by: 'order_date',
      sort_order: 'desc',
      'objects_enabled_for_normalization[order_state]': 'true',
    });

    return `${MISSION_CONTROL_BASE}/${shopId}/mission-control/orders/data?${params.toString()}`;
  }

  // ─── Fetch a single page ──────────────────────────────────────────────────────

  async function fetchOrderPage(shopId, offset, limit, orderStateId) {
    const url = buildApiUrl(shopId, offset, limit, orderStateId);
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'x-csrf-token': getCsrfToken(),
      },
    });
    if (!res.ok) throw new Error(`Etsy API error ${res.status}: ${res.statusText}`);
    return res.json();
  }

  // ─── Get CSRF Token ───────────────────────────────────────────────────────────

  function getCsrfToken() {
    // Etsy stores the CSRF token in a cookie named 'user_prefs' or 'csrf_nonce'
    const cookies = document.cookie.split(';');
    for (const c of cookies) {
      const [k, v] = c.trim().split('=');
      if (k === 'csrf_nonce' || k === 'x_csrf_nonce') return decodeURIComponent(v || '');
    }
    // Also check meta tags
    const meta = document.querySelector('meta[name="csrf-token"], meta[name="x-csrf-token"]');
    return meta?.content || '';
  }

  // ─── Fetch ALL orders (paginated) ─────────────────────────────────────────────

  async function fetchAllOrders(shopId, options = {}) {
    const limit = options.limit || DEFAULT_LIMIT;
    const orderStateId = options.orderStateId || '';
    let offset = 0;
    let totalCount = null;
    const rawOrders = [];

    do {
      const data = await fetchOrderPage(shopId, offset, limit, orderStateId);
      const search = data?.orders_search;
      if (!search) throw new Error('Unexpected API response structure.');

      if (totalCount === null) totalCount = search.total_count || 0;

      rawOrders.push(...(search.orders || []));

      // Build buyer lookup map from this page's buyer list
      const buyerMap = buildBuyerMap(search.buyers || []);

      // Map orders from this page
      const mapped = (search.orders || []).map(o => mapOrder(o, buyerMap, options.storeName));
      if (offset === 0) {
        // Store first page maps, we'll process everything at the end
      }

      offset += search.orders?.length || 0;

      // Notify popup of progress
      chrome.runtime.sendMessage({
        type: 'FETCH_PROGRESS',
        fetched: rawOrders.length,
        total: totalCount,
      }).catch(() => {});

    } while (rawOrders.length < totalCount && rawOrders.length < offset);

    return rawOrders;
  }

  // ─── Build Buyer Lookup Map ───────────────────────────────────────────────────

  function buildBuyerMap(buyers) {
    const map = {};
    for (const b of buyers) {
      map[b.buyer_id] = b;
    }
    return map;
  }

  // ─── Map Etsy Order → Merchemy OS Order ──────────────────────────────────────

  function mapOrder(etsyOrder, buyerMap, storeName) {
    const buyer = buyerMap[etsyOrder.buyer_id] || {};
    const cost  = etsyOrder.payment?.cost_breakdown || {};
    const addr  = etsyOrder.fulfillment?.to_address || {};
    const notes = etsyOrder.notes || {};

    // Money values are in cents → divide by 100
    const centsToDollars = (v) => (typeof v?.value === 'number' ? v.value / 100 : 0);

    const totalAmount  = centsToDollars(cost.total_cost);
    const shippingCost = centsToDollars(cost.shipping_cost);
    const tax          = centsToDollars(cost.tax_cost);
    const discount     = centsToDollars(cost.discount);
    // Subtotal = discounted items cost (what the buyer actually paid for items, excl shipping/tax)
    const subtotal     = centsToDollars(cost.discounted_items_cost);
    const currency     = cost.total_cost?.currency_code || 'USD';

    const customerName = buyer.name || addr.name || 'Unknown Buyer';
    const customerEmail = buyer.email || '';
    const shipName     = addr.name || customerName;
    const shipAddress1 = addr.first_line || '';
    const shipAddress2 = addr.second_line || '';
    const shipCity     = addr.city || '';
    const shipState    = addr.state || '';
    const shipZipcode  = addr.zip || '';
    const shipCountry  = addr.country || '';
    const phone        = addr.phone || '';

    const customerAddress = [shipAddress1, shipAddress2, shipCity, shipState, shipZipcode, shipCountry]
      .filter(Boolean).join(', ');

    const orderDate = etsyOrder.order_date
      ? new Date(etsyOrder.order_date * 1000).toISOString()
      : new Date().toISOString();

    const couponCode = etsyOrder.payment?.sellermarketing_coupons?.[0]?.code || '';
    const paymentMethod = etsyOrder.payment?.payment_method || '';

    // Map transactions → items
    const buyerNote = notes.note_from_buyer || '';
    const items = (etsyOrder.transactions || []).map(tx =>
      mapTransaction(tx, {
        orderId:         String(etsyOrder.order_id),
        orderDate,
        storeName:       storeName || '',
        customerName,
        customerAddress,
        shipName,
        shipAddress1,
        shipAddress2,
        shipCity,
        shipState,
        shipZipcode,
        shipCountry,
        phone,
        buyerNote,
      })
    );

    return {
      id:              String(etsyOrder.order_id),
      storeName:       storeName || '',
      date:            orderDate,
      items,

      // Financials
      totalAmount,
      subtotal,
      discount,
      tax,
      shippingCost,
      currency,

      // Flags
      isRefunded:   etsyOrder.payment?.is_fully_refunded || false,
      isCaseClosed: false,
      isLost:       false,
      isGift:       etsyOrder.is_gift ? 'Yes' : '',

      // Customer
      customerName,
      customerEmail,
      customerAddress,
      shipAddress1,
      shipAddress2,
      shipCity,
      shipState,
      shipZipcode,
      shipCountry,

      // Metadata
      couponCode,
      paymentMethod,
      orderUrl: etsyOrder.order_url || '',
    };
  }

  // ─── Map Transaction → Merchemy OS OrderItem ──────────────────────────────────

  function mapTransaction(tx, orderCtx) {
    const product    = tx.product || {};
    const variations = tx.variations || [];

    const variationStr = variations.map(v => `${v.property}: ${v.value}`).join(' | ');

    // SKU: use product_identifier (e.g. "VCN-CA-S2D0169-CTV")
    const sku = product.product_identifier || '';

    // Price in cents → dollars (full listing price before discount)
    const price = typeof tx.usd_price === 'number' ? tx.usd_price / 100 : (tx.cost?.value || 0) / 100;

    return {
      id:              String(tx.transaction_id),
      name:            product.title || 'Unknown Product',
      sku,
      listingId:       String(tx.listing_id || ''),
      transactionId:   String(tx.transaction_id),
      quantity:        tx.quantity || 1,
      price,
      variations:      variationStr,
      personalization: orderCtx.buyerNote,

      // Shipping / Order context (flattened onto each item — Merchemy OS style)
      orderId:         orderCtx.orderId,
      orderDate:       orderCtx.orderDate,
      storeName:       orderCtx.storeName,
      customerName:    orderCtx.customerName,
      customerAddress: orderCtx.customerAddress,
      shipName:        orderCtx.shipName,
      shipAddress1:    orderCtx.shipAddress1,
      shipAddress2:    orderCtx.shipAddress2,
      shipCity:        orderCtx.shipCity,
      shipState:       orderCtx.shipState,
      shipZipcode:     orderCtx.shipZipcode,
      shipCountry:     orderCtx.shipCountry,
      phone:           orderCtx.phone,

      // Cost defaults
      baseCost:   0,
      costSource: null,
      status:     'New',
    };
  }

  // ─── Main Message Handler ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SCRAPE_ETSY_ORDERS') {
      handleScrape(message, sendResponse);
      return true; // async
    }

    if (message.type === 'GET_SHOP_ID') {
      const shopId = getShopId();
      sendResponse({ ok: true, shopId });
      return true;
    }
  });

  async function handleScrape(message, sendResponse) {
    try {
      // 1. Get shop ID
      let shopId = message.shopId || getShopId();
      if (!shopId) {
        sendResponse({
          ok: false,
          error:
            'Could not detect your Etsy Shop ID. Please navigate to your Etsy Shop Manager or Orders page first.',
        });
        return;
      }

      // 2. Fetch one page first to get total count and first batch
      const firstPage = await fetchOrderPage(shopId, 0, DEFAULT_LIMIT, message.orderStateId || '');
      const search = firstPage?.orders_search;
      if (!search) {
        sendResponse({ ok: false, error: 'Unexpected API response structure from Etsy.' });
        return;
      }

      const totalCount = search.total_count || 0;
      let buyerMap = buildBuyerMap(search.buyers || []);
      let allMapped = (search.orders || []).map(o =>
        mapOrder(o, buyerMap, message.storeName)
      );

      // 3. Paginate if there are more orders
      let offset = search.orders?.length || 0;
      let hasMore = search.orders && search.orders.length === DEFAULT_LIMIT;

      while (hasMore) {
        const page = await fetchOrderPage(shopId, offset, DEFAULT_LIMIT, message.orderStateId || '');
        const ps = page?.orders_search;
        if (!ps || !ps.orders || ps.orders.length === 0) break;

        const pageBuyerMap = buildBuyerMap(ps.buyers || []);
        const pageMapped = ps.orders.map(o =>
          mapOrder(o, pageBuyerMap, message.storeName)
        );
        allMapped = allMapped.concat(pageMapped);
        offset += ps.orders.length;

        // Progress notification
        chrome.runtime.sendMessage({
          type: 'FETCH_PROGRESS',
          fetched: allMapped.length,
          total: Math.max(totalCount, allMapped.length),
        }).catch(() => {});

        if (ps.orders.length < DEFAULT_LIMIT) break;
      }

      sendResponse({
        ok: true,
        orders: allMapped,
        count: allMapped.length,
        total: totalCount,
        shopId,
      });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  }

  console.log('[Merchemy Scraper] Etsy Mission Control API connector loaded.');
})();
