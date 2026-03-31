// background.js — Service Worker
// Handles API communication with Merchemy OS backend

import { scrapeEtsyOrders } from './background/etsy-scraper.js';


const DEFAULT_API_URL = "http://localhost:3000/api/v2";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

// ─── Push orders to Merchemy OS ───────────────────────────────────────────────

async function handlePushOrders(orders) {
  const { apiUrl, authToken } = await getSettings();

  if (!authToken)
    throw new Error("Not logged in. Please sign in via the extension popup.");
  if (!orders?.length) throw new Error("No orders to push.");

  const CHUNK_SIZE = 50;
  let pushed = 0;

  for (let i = 0; i < orders.length; i += CHUNK_SIZE) {
    const chunk = orders.slice(i, i + CHUNK_SIZE);
    const res = await fetch(`${apiUrl}/orders/bulk`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ orders: chunk }),
    });

    if (res.status === 401) {
      // Token expired — clear it so next popup open shows login
      chrome.storage.local.set({ authToken: "" });
      throw new Error("Session expired. Please sign in again.");
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
      });
    });
  });
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
  await chrome.alarms.clear("midnightSync"); // cleanup old
  
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
  if (alarm.name === "autoSync" || alarm.name === "midnightSync") {
    console.log("[Auto-Sync] Firing sync alarm...");
    const { shopId, defaultStore, autoSyncEnabled } = await new Promise((res) => chrome.storage.local.get(["shopId", "defaultStore", "autoSyncEnabled"], res));
    
    if (autoSyncEnabled === false) {
      console.log("[Auto-Sync] Aborted. Auto-sync is disabled by user.");
      return;
    }

    if (!shopId) {
      console.log("[Auto-Sync] Aborted. No shopId stored in extension.");
      return;
    }
    
    try {
      const orders = await scrapeEtsyOrders(shopId, defaultStore || "Etsy Shop");
      console.log(`[Auto-Sync] Successfully scraped ${orders.length} orders. Pushing...`);
      if (orders.length > 0) {
        const result = await handlePushOrders(orders);
        console.log(`[Auto-Sync] Successfully pushed ${result.pushed} orders to Merchemy OS.`);
      }
    } catch (err) {
      console.error("[Auto-Sync] Error during background sync:", err);
    }
  }
});
