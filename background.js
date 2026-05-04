// background.js — Service Worker
// Handles API communication with Sellfern backend




const DEFAULT_API_URL = "https://api.sellfern.com/api/v2";

let cancelPushFlag = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CANCEL_PUSH") {
    cancelPushFlag = true;
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "UPDATE_ALARM") {
    setupSyncAlarm();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "PUSH_ORDERS") {
    handlePushOrders(message.orders)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "GET_SETTINGS") {
    chrome.storage.local.get(
      ["apiUrl", "authToken", "defaultStore"],
      (data) => {
        sendResponse({
          apiUrl: data.apiUrl || DEFAULT_API_URL,
          authToken: data.authToken || "",
          defaultStore: data.defaultStore || "",
        });
      },
    );
    return true;
  }
});

// ─── Refresh Token Helper ─────────────────────────────────────────────────────

async function refreshFullToken() {
  const { apiUrl, refreshToken } = await new Promise(res => chrome.storage.local.get(["apiUrl", "refreshToken"], res));
  if (!refreshToken) throw new Error("No refresh token");
  const url = (apiUrl || "https://api.sellfern.com/api/v2") + "/auth/refresh";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken })
  });
  if (!res.ok) throw new Error("Refresh failed");
  const data = await res.json();
  await new Promise(res => chrome.storage.local.set({ authToken: data.token, refreshToken: data.refreshToken }, res));
  return data.token;
}

// ─── Push orders to Sellfern ─────────────────────────────────────────────────

async function handlePushOrders(orders) {
  let { apiUrl, authToken, defaultStore } = await getSettings();

  if (!authToken)
    throw new Error("Not logged in. Please sign in via the extension popup.");
  if (!orders?.length) throw new Error("No orders to push.");

  const storeName = defaultStore || orders[0]?.storeName;
  if (storeName) {
    const isRegistered = await checkStoreRegistered(storeName, apiUrl, authToken);
    if (!isRegistered) {
      throw new Error(`Store "${storeName}" does not exist in the system. Please add this Store to Sellfern first.`);
    }
  }

  const CHUNK_SIZE = 50;
  let pushed = 0;
  cancelPushFlag = false;

  for (let i = 0; i < orders.length; i += CHUNK_SIZE) {
    if (cancelPushFlag) break;
    const chunk = orders.slice(i, i + CHUNK_SIZE);
    let res = await fetch(`${apiUrl}/orders/bulk`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ orders: chunk }),
    });

    if (res.status === 401) {
      try {
        authToken = await refreshFullToken();
        res = await fetch(`${apiUrl}/orders/bulk`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ orders: chunk }),
        });
      } catch (err) {
        // Token expired — clear it so next popup open shows login
        chrome.storage.local.set({ authToken: "", refreshToken: "" });
        throw new Error("Session expired. Please sign in again.");
      }
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}: Upload failed.`);
    }

    pushed += chunk.length;
    chrome.runtime
      .sendMessage({ type: "PUSH_PROGRESS", pushed, total: orders.length })
      .catch(() => {});
  }

  return { pushed };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["apiUrl", "authToken"], (data) => {
      resolve({
        apiUrl: data.apiUrl || DEFAULT_API_URL,
        authToken: data.authToken || "",
        defaultStore: data.defaultStore || "",
      });
    });
  });
}

async function addSystemLog(type, message) {
  const { systemLogs = [] } = await new Promise((res) => chrome.storage.local.get("systemLogs", res));
  systemLogs.unshift({ time: new Date().toISOString(), type, message });
  if (systemLogs.length > 50) systemLogs.pop();
  await new Promise((res) => chrome.storage.local.set({ systemLogs }, res));
}

async function checkStoreRegistered(storeName, apiUrl, authToken) {
  if (!storeName) return true;
  try {
    const url = (apiUrl || "https://sellfern.com/api/v2") + "/stores";
    let res = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`
      }
    });

    if (res.status === 401) {
      try {
        authToken = await refreshFullToken();
        res = await fetch(url, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${authToken}`
          }
        });
      } catch (err) {
        // Allow fallback behaviour to skip validation if auth fails
      }
    }
    if (!res.ok) return true; // Ignore validation if API is unreachable
    const stores = await res.json();
    return stores.some(s => s.name?.toLowerCase() === storeName.toLowerCase() && s.platform?.toLowerCase() === "etsy");
  } catch (e) {
    return true; // Ignore if network disconnects
  }
}

// ─── Auto-Sync (Custom Schedule) ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  setupSyncAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  setupSyncAlarm();
});

async function setupSyncAlarm() {
  const { autoSyncEnabled, syncMode, syncTime, syncHours, syncStartTime } = await new Promise((res) => chrome.storage.local.get(["autoSyncEnabled", "syncMode", "syncTime", "syncHours", "syncStartTime"], res));
  
  await chrome.alarms.clear("autoSync");
  
  if (autoSyncEnabled === false) {
    console.log("[Auto-Sync] Disabled by user.");
    return;
  }
  
  const mode = syncMode || "daily";
  
  if (mode === "hourly") {
    const hours = parseInt(syncHours || 4, 10);
    const startStr = syncStartTime || "00:00";
    const [hh, mm] = startStr.split(":").map(Number);
    const now = new Date();
    
    let nextRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    
    // Fast-forward nextRun to the imminent future occurrence
    while (nextRun.getTime() <= now.getTime()) {
      nextRun.setTime(nextRun.getTime() + hours * 60 * 60 * 1000);
    }
    
    chrome.alarms.create("autoSync", {
      when: nextRun.getTime(),
      periodInMinutes: hours * 60
    });
    console.log(`[Auto-Sync] Created periodic alarm for every ${hours} hours starting at ${nextRun.toLocaleString()}.`);
  } else {
    const timeStr = syncTime || "00:00";
    const [hh, mm] = timeStr.split(":").map(Number);
    
    // Calculate next run time
    const now = new Date();
    let nextRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    
    if (nextRun.getTime() <= now.getTime()) {
      nextRun.setDate(nextRun.getDate() + 1);
    }
    
    chrome.alarms.create("autoSync", {
      when: nextRun.getTime(),
      periodInMinutes: 1440 // 24 hours
    });
    console.log(`[Auto-Sync] Created daily alarm for ${nextRun.toLocaleString()} (${timeStr})`);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "autoSync") {
    console.log("[Auto-Sync] Firing sync alarm...");
    const { shopId, defaultStore, autoSyncEnabled, orderStates, completedTimeframe } = await new Promise((res) => chrome.storage.local.get(["shopId", "defaultStore", "autoSyncEnabled", "orderStates", "completedTimeframe"], res));
    
    if (autoSyncEnabled === false) {
      console.log("[Auto-Sync] Aborted. Auto-sync is disabled by user.");
      return;
    }

    // shopId will be detected later if missing
    
    try {
      // 1. Find an existing Etsy tab to perform the scrape in the 'web' context
      let [tab] = await chrome.tabs.query({ url: "*://*.etsy.com/*" });
      let tabCreated = false;

      if (!tab) {
        console.log("[Auto-Sync] No open Etsy tab found. Opening a background tab...");
        // Open to a safe Etsy URL
        tab = await chrome.tabs.create({ url: "https://www.etsy.com/your/shops/me/dashboard", active: false });
        tabCreated = true;
        // Wait for tab to load
        await new Promise((resolve) => {
          const listener = (tabId, info) => {
            if (tabId === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
        });
        // Give it a moment to stabilize/scripts to run
        await new Promise(r => setTimeout(r, 2000));
      }

      console.log(`[Auto-Sync] Using tab ${tab.id} for scraping...`);

      // 2. Inject content script if not already there (safely handled by content/etsy.js guard)
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/etsy.js"],
      }).catch(() => {});

      // Find "New" state from saved orderStates
      let targetOrderStateId = "";
      let targetOrderStateLabel = "";
      if (orderStates && Array.isArray(orderStates)) {
        const newState = orderStates.find(s => s.label && s.label.toLowerCase().includes('new'));
        if (newState && newState.id) {
          targetOrderStateId = String(newState.id);
          targetOrderStateLabel = newState.label;
        }
      }

      if (!shopId || !targetOrderStateId) {
        console.log("[Auto-Sync] Missing Shop ID or Order State ID. Attempting to detect on active tab...");
        try {
          // 1. Detect Shop Info
          const [shopResult] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              function getDetectedShopId() {
                const metaShopId = document.querySelector('meta[name="shop-id"]');
                if (metaShopId?.content) return metaShopId.content;
                try {
                  const globals = window.__reactPageGlobals || window.__page_globals || {};
                  if (globals.shop_id) return String(globals.shop_id);
                  if (globals.business_id) return String(globals.business_id);
                } catch (_) {}
                try { if (window.etsy?.Session?.shopId) return String(window.etsy.Session.shopId); } catch (_) {}
                const mcLinks = Array.from(document.querySelectorAll('a[href*="mission-control"], script')).map(el => el.href || el.src || el.textContent || '').join(' ');
                const mcMatch = mcLinks.match(/\/shop\/(\d+)\//);
                if (mcMatch) return mcMatch[1];
                const urlMatch = window.location.href.match(/\/shop\/(\d+)\//);
                if (urlMatch) return urlMatch[1];
                const scripts = document.querySelectorAll('script[type="application/json"], script:not([src])');
                for (const s of scripts) {
                  const m = s.textContent.match(/"business_id"\s*:\s*(\d+)/);
                  if (m) return m[1];
                  const m2 = s.textContent.match(/"shop_id"\s*:\s*(\d+)/);
                  if (m2) return m2[1];
                }
                return null;
              }
              const dShopId = getDetectedShopId();
              let dStoreName = "";
              try {
                const globals = window.__reactPageGlobals || window.__page_globals || {};
                if (globals.shop_name) dStoreName = String(globals.shop_name);
              } catch (_) {}
              if (!dStoreName) {
                 const scripts = document.querySelectorAll('script');
                 for (const s of scripts) {
                   const nameM = s.textContent.match(/"shop_name"\s*:\s*"([^"]+)"/);
                   if (nameM) { dStoreName = nameM[1]; break; }
                 }
              }
              return { detectedShopId: dShopId, detectedStoreName: dStoreName };
            }
          });

          if (shopResult?.result) {
            const { detectedShopId, detectedStoreName } = shopResult.result;
            if (detectedShopId) {
              shopId = detectedShopId;
              defaultStore = detectedStoreName || defaultStore || "Etsy Shop";
              await chrome.storage.local.set({ shopId, defaultStore });
              console.log("[Auto-Sync] Successfully auto-detected Shop ID:", shopId);
            }
          }

          // 2. Detect Order States
          const detectRes = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, { type: "GET_ORDER_STATES" }, (res) => resolve(res || {}));
          });
          
          if (detectRes.ok && detectRes.states) {
            const detectedNew = detectRes.states.find(s => s.label.toLowerCase().includes('new'));
            if (detectedNew && detectedNew.id) {
               targetOrderStateId = String(detectedNew.id);
               targetOrderStateLabel = detectedNew.label;
               
               let updatedStates = (orderStates && Array.isArray(orderStates) && orderStates.length >= 2) 
                  ? orderStates 
                  : [{ id: '', label: 'New' }, { id: '', label: 'Completed' }];
               
               const stateToUpdate = updatedStates.find(s => s.label === 'New');
               if (stateToUpdate) stateToUpdate.id = targetOrderStateId;
               
               const detectedCompleted = detectRes.states.find(s => s.label.toLowerCase().includes('completed'));
               if (detectedCompleted && detectedCompleted.id) {
                 const completedState = updatedStates.find(s => s.label === 'Completed');
                 if (completedState) completedState.id = String(detectedCompleted.id);
               }
               
               await chrome.storage.local.set({ orderStates: updatedStates });
               console.log("[Auto-Sync] Successfully auto-detected Order States.");
            }
          }
        } catch(e) {
          console.error("[Auto-Sync] Lỗi khi detect thông tin:", e);
        }

        if (!shopId || !targetOrderStateId) {
          throw new Error("[Auto-Sync] Failed to auto-detect Shop ID or Order State ID (New). Please detect manually on the Popup.");
        }
      }

      // 3. Send message to start scraping
      const response = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, {
          type: "SCRAPE_ETSY_ORDERS",
          shopId,
          storeName: defaultStore || "Etsy Shop",
          orderStateId: targetOrderStateId,
          orderStateLabel: targetOrderStateLabel,
          timeframeValue: completedTimeframe || "last_90_days"
        }, (res) => {
          if (chrome.runtime.lastError) {
             resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
             resolve(res);
          }
        });
      });

      // 4. Cleanup if we created the tab
      if (tabCreated) {
        chrome.tabs.remove(tab.id);
      }

      if (!response || !response.ok) {
        throw new Error(response?.error || "[Auto-Sync] Scrape failed in content script.");
      }

      const orders = response.orders || [];
      console.log(`[Auto-Sync] Successfully scraped ${orders.length} orders. Pushing...`);
      
      if (orders.length > 0) {
        const result = await handlePushOrders(orders);
        console.log(`[Auto-Sync] Successfully pushed ${result.pushed} orders to Sellfern.`);
        await addSystemLog("success", `[Auto-Sync] Successfully fetched and pushed ${result.pushed} orders (New state).`);
      } else {
        console.log(`[Auto-Sync] No new orders found.`);
        await addSystemLog("info", `[Auto-Sync] No new orders found (New state).`);
      }
    } catch (err) {
      console.error("[Auto-Sync] Error during background sync:", err);
      await addSystemLog("error", err.message || "Unknown error during auto fetch and push.");
    }
  }
});

