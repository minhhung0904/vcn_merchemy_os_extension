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
  const DEFAULT_ORDER_STATE = '1347445165725'; // empty = all states, 1347445165725 = completed (last 90 days)

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
    let sortBy = 'ship_date';
    let sortOrder = 'desc';
    let completedDate = 'all';

    const isNew = String(orderStateId) === '1347445165681';
    const isCompleted = String(orderStateId) === '1347445165725';

    if (isNew) {
      sortBy = 'expected_ship_date';
      sortOrder = 'asc';
      completedDate = 'all';
    } else if (isCompleted) {
      sortBy = 'ship_date';
      sortOrder = 'desc';
      completedDate = 'last_90_days';
    }

    const params = new URLSearchParams({
      'filters[buyer_id]': 'all',
      'filters[channel]': 'all',
      'filters[completed_status]': 'all',
      'filters[completed_date]': completedDate,
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
      sort_by: sortBy,
      sort_order: sortOrder,
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

      // Specifically target window.Etsy.Context for more accurate data
      if (text.includes('window.Etsy.Context')) {
        const pgMatch = text.match(/"page_guid"\s*:\s*"([^"]+)"/);
        if (pgMatch) pageGuid = pgMatch[1];
        
        const locMatch = text.match(/"detected_locale"\s*:\s*"([^"]+)"/);
        if (locMatch) detectedLocale = locMatch[1];
      }

      if (!pageGuid) {
        const m = text.match(/"page_guid"\s*:\s*"([^"]+)"/) || text.match(/"x-page-guid"\s*:\s*"([^"]+)"/);
        if (m) pageGuid = m[1];
      }

      if (!detectedLocale) {
        const m = text.match(/"detected_locale"\s*:\s*"([^"]+)"/);
        if (m) detectedLocale = m[1];
      }

      if (pageGuid && detectedLocale) break;
    }

    return {
      pageGuid: pageGuid || '1024fa296596.7d7de2f619857ec9e7e3.00',
      orderStateId: orderStateId || fallbackStateId || '1347445165725',
      detectedLocale: detectedLocale || 'NZD|en-GB|NZ'
    };
  }

  /**
   * Scans the page's scripts for all order_state_id and label pairs.
   */
  function getOrderStates() {
    const states = [];
    const seenIds = new Set();
    const scripts = document.querySelectorAll('script');

    for (const s of scripts) {
      const text = s.textContent;
      if (!text) continue;

      // Type 1: Label/Name and ID pair (handles fields in between)
      // Pattern: "name":"New", ..., "order_state_id":123
      const matches = text.matchAll(/"(?:label|name)"\s*:\s*"([^"]+)"[^}]*?"order_state_id"\s*:\s*"?(\d+)"?/gi);
      for (const m of matches) {
        const label = m[1];
        const id = m[2];
        if (!seenIds.has(id)) {
          states.push({ label, id });
          seenIds.add(id);
        }
      }

      // Reverse Pattern: "order_state_id":123, ..., "name":"New"
      const reverseMatches = text.matchAll(/"order_state_id"\s*:\s*"?(\d+)"?[^}]*?"(?:label|name)"\s*:\s*"([^"]+)"/gi);
      for (const m of reverseMatches) {
        const id = m[1];
        const label = m[2];
        if (!seenIds.has(id)) {
          states.push({ label, id });
          seenIds.add(id);
        }
      }

      // Type 2: Order state ID and URL pair (very robust)
      // For Completed: /your/orders/sold/completed
      const completedMatch = text.match(/"order_state_id"\s*:\s*"(\d+)"[^}]*?"url"\s*:\s*"[^"]*\/your\/orders\/sold\/completed"/) ||
                             text.match(/"url"\s*:\s*"[^"]*\/your\/orders\/sold\/completed"[^}]*?"order_state_id"\s*:\s*"(\d+)"/);
      if (completedMatch && !seenIds.has(completedMatch[1])) {
        states.push({ label: "Completed", id: completedMatch[1] });
        seenIds.add(completedMatch[1]);
      }

      // For New: /your/orders/sold (without /completed)
      // Caution: the regex must not match /completed
      const newMatch = text.match(/"order_state_id"\s*:\s*"(\d+)"[^}]*?"url"\s*:\s*"[^"]*\/your\/orders\/sold(?!\/completed)"/) ||
                       text.match(/"url"\s*:\s*"[^"]*\/your\/orders\/sold(?!\/completed)"[^}]*?"order_state_id"\s*:\s*"(\d+)"/);
      if (newMatch && !seenIds.has(newMatch[1])) {
        states.push({ label: "New", id: newMatch[1] });
        seenIds.add(newMatch[1]);
      }

      // Type 3: Handle the Etsy.Context structure specifically if found as a single block
      // This is a more targeted approach for the snippet provided by the user
      if (text.includes('window.Etsy.Context')) {
        const orderStatesMatch = text.match(/"order_states"\s*:\s*(\[[^\]]+\])/);
        if (orderStatesMatch) {
          try {
            const orderStates = JSON.parse(orderStatesMatch[1]);
            orderStates.forEach(s => {
              const id = String(s.order_state_id);
              const label = s.name || s.label;
              if (id && label && !seenIds.has(id)) {
                states.push({ label, id });
                seenIds.add(id);
              }
            });
          } catch (e) {
            // Fallback to regex if JSON.parse fails (e.g. if it's not a complete array)
          }
        }
      }
    }

    // Type 4: Try to find in __reactPageGlobals if available
    try {
      const globals = window.__reactPageGlobals || window.__page_globals || {};
      if (globals.order_states && Array.isArray(globals.order_states)) {
        globals.order_states.forEach(s => {
          if (s.order_state_id && !seenIds.has(String(s.order_state_id))) {
            states.push({ label: s.label || s.name || String(s.order_state_id), id: String(s.order_state_id) });
            seenIds.add(String(s.order_state_id));
          }
        });
      }
    } catch (_) {}

    // Type 5: DOM Fallback (Scrape sidebar links)
    const links = document.querySelectorAll('a[href*="order_state_id="]');
    links.forEach(a => {
      const url = new URL(a.href, window.location.origin);
      const id = url.searchParams.get('order_state_id');
      const label = a.textContent.trim().split('(')[0].trim(); // Remove count like (10)
      if (id && label && !seenIds.has(id)) {
        states.push({ label, id });
        seenIds.add(id);
      }
    });

    // Also check for specific class-based links if known
    const navLinks = document.querySelectorAll('a[href*="/your/orders/sold"]');
    navLinks.forEach(a => {
      const href = a.getAttribute('href');
      let label = a.textContent.trim().split('(')[0].trim();
      let id = '';

      if (href.includes('/completed')) {
        // Find ID from scripts later or if data attribute exists
      }
    });

    return states;
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
    // State-specific headers
    const isNew = String(orderStateId) === '1347445165681'; 
    const isCompleted = String(orderStateId) === '1347445165725';
    
    const referer = isNew 
      ? 'https://www.etsy.com/your/orders/sold/new?ref=seller-platform-mcnav'
      : 'https://www.etsy.com/your/orders/sold/completed?ref=seller-platform-mcnav&completed_date=last_90_days';

    const headers = {
      ...deviceHeaders,
      'accept': '*/*',
      'accept-language': 'vi,en-US;q=0.9,en;q=0.8,fr-FR;q=0.7,fr;q=0.6',
      'content-type': 'application/json',
      'referer': referer,
      'x-detected-locale': detectedLocale,
      'x-page-guid': pageGuid,
    };

    if (isCompleted) {
      headers['x-transform-response'] = 'camel-case';
    }

    const res = await fetch(url.toString(), {
      method: 'GET',
      credentials: 'include',
      headers: headers,
    });
    if (!res.ok) throw new Error(`Etsy API error ${res.status}: ${res.statusText}`);
    return res.json();
  }

  /**
   * Fetches shipment info (tracking number, carrier) for a list of order IDs.
   */
  async function fetchShipments(shopId, orderIds, ctx) {
    if (!orderIds || orderIds.length === 0) return {};
    const { pageGuid, detectedLocale } = ctx;
    const deviceHeaders = await getDeviceHeaders();
    
    // Batch in 50 IDs per call
    const batchSize = 50;
    const allShipments = {};
    
    for (let i = 0; i < orderIds.length; i += batchSize) {
      const batch = orderIds.slice(i, i + batchSize);
      const url = new URL(`https://www.etsy.com/api/v3/ajax/shop/${shopId}/shipments/by-order`);
      batch.forEach(id => url.searchParams.append('order_ids[]', id));
      
      try {
        const res = await fetch(url.toString(), {
          method: 'GET',
          credentials: 'include',
          headers: {
            ...deviceHeaders,
            'accept': '*/*',
            'accept-language': 'vi,en-US;q=0.9,en;q=0.8,fr-FR;q=0.7,fr;q=0.6',
            'content-type': 'application/json',
            'referer': window.location.href,
            'x-detected-locale': detectedLocale,
            'x-page-guid': pageGuid,
            'x-transform-response': 'camel-case',
          },
        });
        
        if (res.ok) {
          const data = await res.json();
          // Etsy returns an object where keys are order IDs
          Object.assign(allShipments, data);
        }
      } catch (e) {
        console.error('[Merchemy Scraper] Failed to fetch shipments batch', e);
      }
    }
    
    return allShipments;
  }

  // ─── Fetch ALL orders (paginated) ─────────────────────────────────────────────

  // Helper to get value from either snake_case or camelCase key
  const getV = (obj, snake, camel) => {
    if (!obj) return undefined;
    return obj[snake] !== undefined ? obj[snake] : obj[camel];
  };

  async function fetchAllOrders(shopId, options = {}) {
    const ctx = getDynamicContext(options.orderStateId || DEFAULT_ORDER_STATE);
    const limit = options.limit || DEFAULT_LIMIT;
    let offset = 0;
    let totalCount = null;
    const rawOrders = [];

    do {
      const data = await fetchOrderPage(shopId, offset, limit, ctx);
      const search = data?.orders_search || data?.ordersSearch;
      if (!search) throw new Error('Unexpected API response structure.');

      if (totalCount === null) totalCount = getV(search, 'total_count', 'totalCount') || 0;

      rawOrders.push(...(search.orders || []));

      // Build buyer lookup map from this page's buyer list
      const buyerMap = buildBuyerMap(search.buyers || []);

      // Map orders from this page
      const mapped = (search.orders || []).map(o => mapOrder(o, buyerMap, options.storeName));

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
      const id = getV(b, 'buyer_id', 'buyerId');
      if (id) map[id] = b;
    }
    return map;
  }

  // ─── Map Etsy Order → Merchemy OS Order ──────────────────────────────────────

  function mapOrder(etsyOrder, buyerMap, storeName, orderCtx = {}) {
    const buyer_id = getV(etsyOrder, 'buyer_id', 'buyerId');
    const buyer = buyerMap[buyer_id] || {};
    const payment = etsyOrder.payment || {};
    const cost  = getV(payment, 'cost_breakdown', 'costBreakdown') || {};
    const fulfillment = etsyOrder.fulfillment || {};
    const addr  = getV(fulfillment, 'to_address', 'toAddress') || {};
    const notes = etsyOrder.notes || {};

    // Money values are in cents → divide by 100
    const centsToDollars = (v) => (typeof v?.value === 'number' ? v.value / 100 : 0);

    const totalAmount  = centsToDollars(getV(cost, 'total_cost', 'totalCost'));
    const shippingCost = centsToDollars(getV(cost, 'shipping_cost', 'shippingCost'));
    const tax          = centsToDollars(getV(cost, 'tax_cost', 'taxCost'));
    const discount     = centsToDollars(cost.discount);
    // Subtotal = discounted items cost (what the buyer actually paid for items, excl shipping/tax)
    const subtotal     = centsToDollars(getV(cost, 'discounted_items_cost', 'discountedItemsCost'));
    const currency     = getV(cost, 'total_cost', 'totalCost')?.currency_code || 'USD';

    const customerName = buyer.name || addr.name || 'Unknown Buyer';
    const customerEmail = buyer.email || '';
    const shipName     = addr.name || customerName;
    const shipAddress1 = getV(addr, 'first_line', 'firstLine') || '';
    const shipAddress2 = getV(addr, 'second_line', 'secondLine') || '';
    const shipCity     = addr.city || '';
    const shipState    = addr.state || '';
    const shipZipcode  = addr.zip || '';
    const shipCountry  = addr.country || '';
    const phone        = addr.phone || '';

    const customerAddress = [shipAddress1, shipAddress2, shipCity, shipState, shipZipcode, shipCountry]
      .filter(Boolean).join(', ');

    const orderDateVal = getV(etsyOrder, 'order_date', 'orderDate');
    const orderDate = orderDateVal
      ? new Date(orderDateVal * 1000).toISOString()
      : new Date().toISOString();

    const coupons = getV(payment, 'sellermarketing_coupons', 'sellermarketingCoupons');
    const couponCode = coupons?.[0]?.code || '';
    const paymentMethod = getV(payment, 'payment_method', 'paymentMethod') || '';

    // Map transactions → items
    const orderId = String(getV(etsyOrder, 'order_id', 'orderId'));
    const shipment = (orderCtx.shipments && orderCtx.shipments[orderId])?.[0] || null;

    // Map transactions → items
    const buyerNote = getV(notes, 'note_from_buyer', 'noteFromBuyer') || '';
    const txs = getV(etsyOrder, 'transactions', 'transactions') || [];
    const items = txs.map(tx =>
      mapTransaction(tx, {
        orderId,
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
        orderStateId:    orderCtx.orderStateId,
      }, shipment)
    );

    return {
      id:              orderId,
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
      isRefunded:   getV(payment, 'is_fully_refunded', 'isFullyRefunded') || false,
      isCaseClosed: false,
      isLost:       false,
      isGift:       getV(etsyOrder, 'is_gift', 'isGift') ? 'Yes' : '',

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
      orderUrl: getV(etsyOrder, 'order_url', 'orderUrl') || '',
    };
  }

  // ─── Map Transaction → Merchemy OS OrderItem ──────────────────────────────────

  function mapTransaction(tx, orderCtx, shipmentInfo = null) {
    const product    = getV(tx, 'product', 'product') || {};
    const variations = getV(tx, 'variations', 'variations') || [];

    const variationStr = variations.map(v => `${v.property}: ${v.value}`).join(' | ');

    // SKU: use product_identifier (e.g. "VCN-CA-S2D0169-CTV")
    const sku = getV(product, 'product_identifier', 'productIdentifier') || '';

    // Price in cents → dollars (full listing price before discount)
    let priceVal = getV(tx, 'usd_price', 'usdPrice');
    if (typeof priceVal !== 'number') {
      const costObj = getV(tx, 'cost', 'cost');
      priceVal = costObj?.value || 0;
    }
    const price = priceVal / 100;

    // Shipment info if available (often found in Completed orders)
    const trackingNumber = getV(shipmentInfo, 'tracking_number', 'trackingNumber') || '';
    const carrier = getV(shipmentInfo, 'carrier_name', 'carrierName') || '';

    return {
      id:              String(getV(tx, 'transaction_id', 'transactionId')),
      name:            getV(product, 'title', 'title') || 'Unknown Product',
      sku,
      listingId:       String(getV(tx, 'listing_id', 'listingId') || ''),
      transactionId:   String(getV(tx, 'transaction_id', 'transactionId')),
      quantity:        getV(tx, 'quantity', 'quantity') || 1,
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

      // Tracking info
      trackingNumber,
      carrier,

      // Cost defaults
      baseCost:   0,
      costSource: null,
      status:     orderCtx.orderStateId === '1347445165725' ? 'Completed' : 'New',
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

    if (message.type === 'GET_ORDER_STATES') {
      const states = getOrderStates();
      sendResponse({ ok: true, states });
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
      const search = firstPage?.orders_search || firstPage?.ordersSearch;
      if (!search) {
        sendResponse({ ok: false, error: 'Unexpected API response structure from Etsy.' });
        return;
      }

      const totalCount = getV(search, 'total_count', 'totalCount') || 0;
      const orders = getV(search, 'orders', 'orders') || [];
      const buyers = getV(search, 'buyers', 'buyers') || [];
      
      const allRawOrders = [...orders];
      const allBuyers = [...buyers];

      // 3. Paginate if there are more orders
      let offset = orders.length || 0;
      let hasMore = orders.length === DEFAULT_LIMIT;

      while (hasMore) {
        // Random delay (1.5s - 3.5s) to mimic human behavior
        await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 2000) + 1500));

        const page = await fetchOrderPage(shopId, offset, DEFAULT_LIMIT, ctx);
        const ps = page?.orders_search || page?.ordersSearch;
        if (!ps || !getV(ps, 'orders', 'orders') || getV(ps, 'orders', 'orders').length === 0) break;

        const pageOrders = getV(ps, 'orders', 'orders') || [];
        const pageBuyers = getV(ps, 'buyers', 'buyers') || [];
        
        allRawOrders.push(...pageOrders);
        if (pageBuyers) allBuyers.push(...pageBuyers);
        offset += pageOrders.length;

        // Progress notification
        chrome.runtime.sendMessage({
          type: 'FETCH_PROGRESS',
          fetched: allRawOrders.length,
          total: Math.max(totalCount, allRawOrders.length),
        }).catch(() => {});

        if (ps.orders.length < DEFAULT_LIMIT) break;
      }

      // 4. If Completed state, fetch shipment info separately
      let shipments = {};
      const orderStateId = message.orderStateId || DEFAULT_ORDER_STATE;
      const isCompleted = String(orderStateId) === '1347445165725';

      if (isCompleted && allRawOrders.length > 0) {
        const orderIds = allRawOrders.map(o => String(getV(o, 'order_id', 'orderId')));
        shipments = await fetchShipments(shopId, orderIds, ctx);
      }

      // 5. Map everything
      const buyerMap = buildBuyerMap(allBuyers);
      const allMapped = allRawOrders.map(o =>
        mapOrder(o, buyerMap, message.storeName, { orderStateId, shipments })
      );

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
