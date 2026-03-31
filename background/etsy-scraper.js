// background/etsy-scraper.js
// Runs in the background service worker to fetch Etsy orders silently.

const DEFAULT_LIMIT = 50;

export async function scrapeEtsyOrders(shopId, storeName, orderStateId = '') {
  // 1. Get CSRF token via cookies API
  const cookie = await chrome.cookies.get({ url: 'https://www.etsy.com', name: 'csrf_nonce' });
  const csrfToken = cookie ? decodeURIComponent(cookie.value) : '';
  
  if (!csrfToken) {
    throw new Error("Missing Etsy CSRF token. The user might be logged out of Etsy.");
  }

  // 2. Fetch one page to get total count
  const firstPage = await fetchOrderPage(shopId, 0, DEFAULT_LIMIT, orderStateId, csrfToken);
  const search = firstPage?.orders_search;
  if (!search) throw new Error('Unexpected API response structure from Etsy.');

  const totalCount = search.total_count || 0;
  let buyerMap = buildBuyerMap(search.buyers || []);
  let allMapped = (search.orders || []).map(o => mapOrder(o, buyerMap, storeName));

  // 3. Paginate
  let offset = search.orders?.length || 0;
  let hasMore = search.orders && search.orders.length === DEFAULT_LIMIT;

  while (hasMore) {
    // Random delay (1.5s - 3.5s) to mimic human behavior
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 2000) + 1500));

    const page = await fetchOrderPage(shopId, offset, DEFAULT_LIMIT, orderStateId, csrfToken);
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
    sort_by: 'order_date',
    sort_order: 'desc',
    'objects_enabled_for_normalization[order_state]': 'true',
  });
  return `https://www.etsy.com/api/v3/ajax/bespoke/shop/${shopId}/mission-control/orders/data?${params.toString()}`;
}

async function fetchOrderPage(shopId, offset, limit, orderStateId, csrfToken) {
  const url = buildApiUrl(shopId, offset, limit, orderStateId);
  const res = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
      'x-csrf-token': csrfToken,
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
