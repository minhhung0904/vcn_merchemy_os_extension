// background.js — Service Worker
// Handles API communication with Merchemy OS backend

const DEFAULT_API_URL = "https://api.vconnect.global/api/v2";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
