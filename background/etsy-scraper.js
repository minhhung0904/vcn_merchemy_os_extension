// background/etsy-scraper.js
// Runs in the background service worker to fetch Etsy orders silently.

const DEFAULT_LIMIT = 50;

export async function scrapeEtsyOrders(shopId, storeName, orderStateIdFallback = '1347445165681') {
  // 1. Fetch orders page to get dynamic context (page_guid, order_state_id)
  const context = await getDynamicContext(orderStateIdFallback);
  const { pageGuid, orderStateId } = context;

  // 2. Fetch one page first to get total count and first batch
  const firstPage = await fetchOrderPage(shopId, 0, DEFAULT_LIMIT, orderStateId, pageGuid);
  const search = firstPage?.orders_search;
  if (!search) throw new Error('Unexpected API response structure from Etsy.');

  let buyerMap = buildBuyerMap(search.buyers || []);
  let allMapped = (search.orders || []).map(o => mapOrder(o, buyerMap, storeName));

  // 3. Paginate
  let offset = search.orders?.length || 0;
  let hasMore = search.orders && search.orders.length === DEFAULT_LIMIT;

  while (hasMore) {
    // Random delay (1.5s - 3.5s) to mimic human behavior
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 2000) + 1500));

    const page = await fetchOrderPage(shopId, offset, DEFAULT_LIMIT, orderStateId, pageGuid);
    const ps = page?.orders_search;
    if (!ps || !ps.orders || ps.orders.length === 0) break;

    const pageBuyerMap = buildBuyerMap(ps.buyers || []);
    const pageMapped = ps.orders.map(o => mapOrder(o, pageBuyerMap, storeName));
    allMapped = allMapped.concat(pageMapped);
    offset += ps.orders.length;
    
    if (ps.orders.length < DEFAULT_LIMIT) break;
  }

  return allMapped;
}

async function getDynamicContext(fallbackStateId) {
  try {
    const res = await fetch('https://www.etsy.com/your/orders/sold/new', {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': navigator.language ? `${navigator.language},en-US;q=0.9,en;q=0.8` : 'vi,en-US;q=0.9,en;q=0.8',
      }
    });

    if (!res.ok) return { pageGuid: '1024c2b72e2e.ed4169a0ac8c681fa062.00', orderStateId: fallbackStateId, detectedLocale: 'USD|en-US|US' };
    const html = await res.text();

    let pageGuid = '1024c2b72e2e.ed4169a0ac8c681fa062.00';
    const guidMatch = html.match(/"page_guid"\s*:\s*"([^"]+)"/) || html.match(/x-page-guid"?\s*(?:content=|:)\s*"?([^">]+)"?/);
    if (guidMatch) pageGuid = guidMatch[1];

    let orderStateId = fallbackStateId;
    const stateMatch = html.match(/"order_state_id"\s*:\s*"?(\d+)"?/);
    if (stateMatch) orderStateId = stateMatch[1];
    
    let detectedLocale = 'USD|en-US|US';
    const locMatch = html.match(/"detected_locale"\s*:\s*"([^"]+)"/);
    if (locMatch) detectedLocale = locMatch[1];

    return { pageGuid, orderStateId, detectedLocale };
  } catch (err) {
    return { pageGuid: '1024c2b72e2e.ed4169a0ac8c681fa062.00', orderStateId: fallbackStateId, detectedLocale: 'USD|en-US|US' };
  }
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

function buildApiUrl(shopId, offset, limit, orderStateId) {
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
  return `https://www.etsy.com/api/v3/ajax/bespoke/shop/${shopId}/mission-control/orders/data?${params.toString()}`;
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

function buildBuyerMap(buyers) {
  const map = {};
  for (const b of buyers) {
    map[b.buyer_id] = b;
  }
  return map;
}

function mapOrder(etsyOrder, buyerMap, storeName) {
  const buyer = buyerMap[etsyOrder.buyer_id] || {};
  const cost  = etsyOrder.payment?.cost_breakdown || {};
  const addr  = etsyOrder.fulfillment?.to_address || {};
  const notes = etsyOrder.notes || {};

  const centsToDollars = (v) => (typeof v?.value === 'number' ? v.value / 100 : 0);

  const totalAmount  = centsToDollars(cost.total_cost);
  const shippingCost = centsToDollars(cost.shipping_cost);
  const tax          = centsToDollars(cost.tax_cost);
  const discount     = centsToDollars(cost.discount);
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
    totalAmount,
    subtotal,
    discount,
    tax,
    shippingCost,
    currency,
    isRefunded:   etsyOrder.payment?.is_fully_refunded || false,
    isCaseClosed: false,
    isLost:       false,
    isGift:       etsyOrder.is_gift ? 'Yes' : '',
    customerName,
    customerEmail,
    customerAddress,
    shipAddress1,
    shipAddress2,
    shipCity,
    shipState,
    shipZipcode,
    shipCountry,
    couponCode,
    paymentMethod,
    orderUrl: etsyOrder.order_url || '',
  };
}

function mapTransaction(tx, orderCtx) {
  const product    = tx.product || {};
  const variations = tx.variations || [];
  const variationStr = variations.map(v => `${v.property}: ${v.value}`).join(' | ');
  const sku = product.product_identifier || '';

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
    baseCost:   0,
    costSource: null,
    status:     'New',
  };
}
