# Merchemy OS – Order Scraper Extension

A Chrome Extension that fetches orders directly from the **Etsy Mission Control API** and pushes them into **Merchemy OS** via Order Ingestion — replacing the Gmail Live Sync workflow.

---

## 📁 Project Structure

```
merchemy_os_extension/
├── manifest.json           # MV3 extension manifest
├── background.js           # Service worker — API push logic
├── content/
│   └── etsy.js             # Etsy Mission Control API connector + data mapper
├── popup/
│   ├── popup.html          # Extension popup UI
│   ├── popup.css           # Popup styles (dark mode)
│   └── popup.js            # Popup logic
├── settings/
│   ├── settings.html       # Settings page
│   ├── settings.css        # Settings styles
│   └── settings.js         # Settings logic (save/load/test)
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── generate-icons.js       # Icon generation script (node-canvas)
```

---

## 🚀 Quick Start

### 1. Generate Icons
```bash
cd merchemy_os_extension
npm install canvas
node generate-icons.js
```

### 2. Load in Chrome
1. Open `chrome://extensions`
2. Enable **Developer Mode** (top right)
3. Click **Load unpacked**
4. Select the `merchemy_os_extension` folder

### 3. Configure
1. Click the extension icon → **⚙️ Settings**
2. Paste your **Merchemy OS Auth Token** (see below how to get it)
3. Set your **Default Store Name** (must match the store name in Merchemy)
4. Click **Test Connection** → should show 🟢 Connected
5. Click **Save Settings**

### How to get your Auth Token
1. Log in to Merchemy OS in Chrome
2. Open DevTools (F12) → Console
3. Run: `localStorage.getItem('auth_token')`
4. Copy the token and paste into Settings

---

## 🕷 How It Works

```
Etsy (browser session)
    ↓ content/etsy.js calls
Etsy Mission Control API
  GET /api/v3/ajax/bespoke/shop/{shopId}/mission-control/orders/data
    ↓ paginated, JSON
Data Mapper → Merchemy OS Order format
    ↓ background.js pushes via
Merchemy OS API
  POST /api/v2/orders/bulk
```

The content script runs **inside the Etsy tab** so your session cookies are automatically included in the API call — no OAuth or API keys needed for Etsy.

---

## 📊 Data Mapping

| Etsy Field | Merchemy Field |
|---|---|
| `order_id` | `Order.id` |
| `order_date` (Unix timestamp) | `Order.date` (ISO string) |
| `buyer.name` / `buyer.email` | `Order.customerName` / `customerEmail` |
| `cost_breakdown.total_cost.value / 100` | `Order.totalAmount` |
| `cost_breakdown.discounted_items_cost / 100` | `Order.subtotal` |
| `cost_breakdown.shipping_cost / 100` | `Order.shippingCost` |
| `cost_breakdown.tax_cost / 100` | `Order.tax` |
| `cost_breakdown.discount / 100` | `Order.discount` |
| `fulfillment.to_address` | `Order.shipAddress1/2/City/State/Zip/Country` |
| `payment.sellermarketing_coupons[0].code` | `Order.couponCode` |
| `transaction.product.product_identifier` | `OrderItem.sku` |
| `transaction.product.title` | `OrderItem.name` |
| `transaction.variations` | `OrderItem.variations` |
| `notes.note_from_buyer` | `OrderItem.personalization` |

---

## ➕ Adding More Platforms

To add Shopify or Amazon:
1. Create `content/shopify.js` with the same message listener (`SCRAPE_ORDERS`)
2. Add host permissions in `manifest.json`
3. Add the content script entry in `manifest.json`
4. Enable the platform tab in `popup.html` (remove `disabled` class)

---

## ⚠️ Notes

- The extension uses Etsy's **internal** Mission Control API — the same one their own Order Manager page uses. It works as long as you are logged into Etsy in Chrome.
- The `shopId` (numeric Business ID) is auto-detected from the page. If it fails, enter it manually in the popup or Settings.
- All money values from Etsy are in **cents** — the mapper divides by 100.
