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
  const DEFAULT_ORDER_STATE = '1347445165681'; // empty = all states, 1347445165681 = new

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

  function buildApiUrl(shopId, offset = 0, limit = DEFAULT_LIMIT, orderStateId = DEFAULT_ORDER_STATE) {
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
      sort_by: 'expected_ship_date',
      sort_order: 'asc',
      'objects_enabled_for_normalization[order_state]': 'true',
    });

    return `${MISSION_CONTROL_BASE}/${shopId}/mission-control/orders/data?${params.toString()}`;
  }

  // ─── Fetch a single page ──────────────────────────────────────────────────────

  function getDynamicContext(fallbackStateId) {
    let pageGuid = '';
    let orderStateId = '';
    let detectedLocale = '';

    const metaGuid = document.querySelector('meta[name="x-page-guid"], meta[property="x-page-guid"]');
    if (metaGuid && metaGuid.content) pageGuid = metaGuid.content;

    if (!pageGuid) {
      const match = document.cookie.match(/(?:(?:^|.*;\s*)x-page-guid\s*\=\s*([^;]*).*$)|^.*$/);
      if (match && match[1]) pageGuid = decodeURIComponent(match[1]);
    }

    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const text = s.textContent;
      if (!text) continue;

      if (!pageGuid) {
        const m = text.match(/"page_guid"\s*:\s*"([^"]+)"/) || text.match(/"x-page-guid"\s*:\s*"([^"]+)"/);
        if (m) pageGuid = m[1];
      }

      if (!orderStateId) {
        const m = text.match(/"order_state_id"\s*:\s*"?(\d+)"?/);
        if (m) orderStateId = m[1];
      }
      
      if (!detectedLocale) {
        const m = text.match(/"detected_locale"\s*:\s*"([^"]+)"/);
        if (m) detectedLocale = m[1];
      }

      if (pageGuid && orderStateId && detectedLocale) break;
    }

    return {
      pageGuid: pageGuid || '1024c2b72e2e.ed4169a0ac8c681fa062.00',
      orderStateId: orderStateId || fallbackStateId || '1347445165681',
      detectedLocale: detectedLocale || 'USD|en-US|US'
    };
  }

  async function getDeviceHeaders() {
    const headers = {};
    
    if (navigator.userAgentData) {
      headers['sec-ch-ua'] = navigator.userAgentData.brands.map(b => `"${b.brand}";v="${b.version}"`).join(', ');
      headers['sec-ch-ua-mobile'] = navigator.userAgentData.mobile ? '?1' : '?0';
      headers['sec-ch-ua-platform'] = `"${navigator.userAgentData.platform}"`;
      try {
        const he = await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'platformVersion', 'fullVersionList']);
        headers['sec-ch-ua-arch'] = `"${he.architecture || 'x86'}"`;
        headers['sec-ch-ua-bitness'] = `"${he.bitness || '64'}"`;
        headers['sec-ch-ua-platform-version'] = `"${he.platformVersion || ''}"`;
        if (he.fullVersionList && he.fullVersionList.length > 0) {
          headers['sec-ch-ua-full-version-list'] = he.fullVersionList.map(b => `"${b.brand}";v="${b.version}"`).join(', ');
        }
      } catch(e) {}
    } else {
      headers['sec-ch-ua'] = '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"';
      headers['sec-ch-ua-mobile'] = '?0';
      headers['sec-ch-ua-platform'] = '"Windows"';
      headers['sec-ch-ua-arch'] = '"x86"';
      headers['sec-ch-ua-bitness'] = '"64"';
      headers['sec-ch-ua-full-version-list'] = '"Not:A-Brand";v="99.0.0.0", "Google Chrome";v="145.0.7632.176", "Chromium";v="145.0.7632.176"';
      headers['sec-ch-ua-platform-version'] = '"19.0.0"';
    }
    
    const conn = navigator.connection;
    if (conn) {
      if (conn.downlink !== undefined) headers['downlink'] = String(conn.downlink);
      if (conn.effectiveType) headers['ect'] = conn.effectiveType;
      if (conn.rtt !== undefined) headers['rtt'] = String(conn.rtt);
    } else {
      headers['downlink'] = '10';
      headers['ect'] = '4g';
      headers['rtt'] = '0';
    }
    
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? String(window.devicePixelRatio) : '1';
    headers['dpr'] = dpr;
    headers['sec-ch-dpr'] = dpr;
    headers['priority'] = 'u=1, i';
    headers['sec-fetch-dest'] = 'empty';
    headers['sec-fetch-mode'] = 'cors';
    headers['sec-fetch-site'] = 'same-origin';
    headers['user-agent'] = navigator.userAgent;
    
    return headers;
  }

  async function fetchOrderPage(shopId, offset, limit, ctx) {
    const { orderStateId, pageGuid, detectedLocale } = ctx;
    const url = buildApiUrl(shopId, offset, limit, orderStateId);
    const deviceHeaders = await getDeviceHeaders();
    
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        ...deviceHeaders,
        'accept': '*/*',
        'accept-language': navigator.language ? `${navigator.language},en-US;q=0.9,en;q=0.8` : 'vi,en-US;q=0.9,en;q=0.8',
        'content-type': 'application/json',
        'referer': 'https://www.etsy.com/your/orders/sold?ref=seller-platform-mcnav',
        'x-detected-locale': detectedLocale,
        'x-page-guid': pageGuid,
      },
    });
    if (!res.ok) throw new Error(`Etsy API error ${res.status}: ${res.statusText}`);
    return res.json();
  }

  // ─── Fetch ALL orders (paginated) ─────────────────────────────────────────────

  async function fetchAllOrders(shopId, options = {}) {
    const ctx = getDynamicContext(options.orderStateId || DEFAULT_ORDER_STATE);
    const limit = options.limit || DEFAULT_LIMIT;
    let offset = 0;
    let totalCount = null;
    const rawOrders = [];

    do {
      const data = await fetchOrderPage(shopId, offset, limit, ctx);
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

      const ctx = getDynamicContext(message.orderStateId || DEFAULT_ORDER_STATE);

      // 2. Fetch one page first to get total count and first batch
      const firstPage = await fetchOrderPage(shopId, 0, DEFAULT_LIMIT, ctx);
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
        // Random delay (1.5s - 3.5s) to mimic human behavior
        await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 2000) + 1500));

        const page = await fetchOrderPage(shopId, offset, DEFAULT_LIMIT, ctx);
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
