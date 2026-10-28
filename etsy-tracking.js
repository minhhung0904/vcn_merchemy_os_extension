// etsy-tracking.js — pushes tracking numbers to Etsy and finishes the Etsy OAuth connection.
//
// Everything that talks to Etsy runs here, in the browser, so Etsy sees the shop owner's own
// network. Sellfern only keeps the queue and the tokens:
//   1. Connect:  Etsy redirects to http://localhost:8080/callback; we read code+state from that
//                navigation and hand them to Sellfern, which stores the tokens.
//   2. Push:     every hour (and on demand) we claim the pending rows from Sellfern, call the Etsy
//                API for each one and report the outcome back.

import { DEFAULT_API_URL, ETSY_CALLBACK_HOST, ETSY_CALLBACK_PORT, ETSY_CALLBACK_PATH } from "./config.js";

const ETSY_API_BASE = "https://openapi.etsy.com/v3/application";
const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const ALARM_NAME = "etsyTrackingPush";
const PUSH_PERIOD_MINUTES = 60;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let pushRunning = false;
const handledCallbacks = new Set();

// ─── Small helpers ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Spread calls out a little so a batch does not hit Etsy in one burst.
const jitter = (minMs, maxMs) => sleep(minMs + Math.random() * (maxMs - minMs));

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

async function addLog(type, message) {
  const { systemLogs = [] } = await storageGet("systemLogs");
  systemLogs.unshift({ time: new Date().toISOString(), type, message });
  if (systemLogs.length > 50) systemLogs.pop();
  await storageSet({ systemLogs });
}

async function sellfernFetch(path, { method = "GET", body } = {}) {
  const { apiToken } = await storageGet("apiToken");
  if (!apiToken) throw new Error("No API token configured. Please set it in the extension Settings.");

  const res = await fetch(`${DEFAULT_API_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": apiToken },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error("Invalid or expired API token. Please update it in the extension Settings.");

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json?.error?.message || json?.error || json?.message || `Sellfern API error ${res.status}`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }
  return json.success && "data" in json ? json.data : json;
}

// ─── Etsy OAuth: catch the redirect ──────────────────────────────────────────

export function parseEtsyCallback(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }
  if (url.hostname !== ETSY_CALLBACK_HOST || url.port !== ETSY_CALLBACK_PORT || url.pathname !== ETSY_CALLBACK_PATH) {
    return null;
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (!state || (!code && !error)) return null;
  return { code, state, error };
}

function showResultPage(tabId, ok, message) {
  if (tabId === undefined || tabId < 0) return;
  const page = chrome.runtime.getURL(
    `connect/result.html?ok=${ok ? 1 : 0}&message=${encodeURIComponent(message)}`
  );
  chrome.tabs.update(tabId, { url: page }).catch(() => {});
}

export async function handleCallbackNavigation(urlString, tabId) {
  const callback = parseEtsyCallback(urlString);
  if (!callback) return;
  // webNavigation and tabs.onUpdated both fire for the same redirect.
  if (handledCallbacks.has(callback.state)) return;
  handledCallbacks.add(callback.state);

  if (callback.error) {
    const message = `Etsy authorization was not completed (${callback.error}).`;
    await addLog("error", message);
    showResultPage(tabId, false, message);
    return;
  }

  try {
    const store = await sellfernFetch("/stores/etsy/oauth/exchange", {
      method: "POST",
      body: { code: callback.code, state: callback.state },
    });
    const message = `Connected Etsy shop "${store.name}" to Sellfern.`;
    await addLog("success", message);
    await storageSet({ etsyConnectStatus: { ok: true, message, time: Date.now() } });
    showResultPage(tabId, true, message);
  } catch (err) {
    handledCallbacks.delete(callback.state);
    await addLog("error", `Etsy connection failed: ${err.message}`);
    await storageSet({ etsyConnectStatus: { ok: false, message: err.message, time: Date.now() } });
    showResultPage(tabId, false, err.message);
  }
}

// ─── Etsy API calls ──────────────────────────────────────────────────────────

class EtsyCallError extends Error {
  constructor(message, { status = 0, retryable = true } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

function etsyErrorMessage(status, body) {
  const detail = body?.error || body?.error_description || body?.message;
  return `Etsy ${status}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`;
}

async function etsyRequest(store, path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`${ETSY_API_BASE}${path}`, {
      method,
      headers: {
        "x-api-key": store.apiKeyHeader,
        Authorization: `Bearer ${store.accessToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      // Never send Etsy cookies: this must be the API app talking, not the shop owner's session.
      credentials: "omit",
    });
  } catch (err) {
    throw new EtsyCallError(`Network error: ${err.message}`, { retryable: true });
  }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function refreshAccessToken(store) {
  if (!store.refreshToken) {
    throw new EtsyCallError("Etsy token expired and no refresh token is available. Reconnect the store.", {
      retryable: false,
    });
  }
  let res;
  try {
    res = await fetch(ETSY_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: store.clientId,
        refresh_token: store.refreshToken,
      }).toString(),
      credentials: "omit",
    });
  } catch (err) {
    throw new EtsyCallError(`Network error while refreshing Etsy token: ${err.message}`, { retryable: true });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const permanent = res.status === 400 || res.status === 401;
    throw new EtsyCallError(`Could not refresh Etsy token (${etsyErrorMessage(res.status, json)}). Reconnect the store.`, {
      status: res.status,
      retryable: !permanent,
    });
  }

  store.accessToken = json.access_token;
  store.refreshToken = json.refresh_token || store.refreshToken;
  store.expiresAt = new Date(Date.now() + (json.expires_in || 3600) * 1000).toISOString();

  // Etsy may rotate the refresh token, so Sellfern must always get the newest pair.
  await sellfernFetch("/stores/etsy/tracking-queue/tokens", {
    method: "POST",
    body: {
      storeId: store.storeId,
      accessToken: store.accessToken,
      refreshToken: store.refreshToken,
      expiresIn: json.expires_in || 3600,
    },
  });
}

async function ensureFreshToken(store) {
  const expiresAt = store.expiresAt ? Date.parse(store.expiresAt) : 0;
  if (expiresAt && expiresAt - Date.now() > REFRESH_MARGIN_MS) return;
  await refreshAccessToken(store);
}

// Calls Etsy, refreshing the token once if Etsy says it is no longer valid.
async function etsyCall(store, path, options) {
  let result = await etsyRequest(store, path, options);
  if (result.status === 401) {
    await refreshAccessToken(store);
    result = await etsyRequest(store, path, options);
  }
  return result;
}

function failureFor(status, json) {
  const message = etsyErrorMessage(status, json);
  const retryable = status === 429 || status >= 500;
  return new EtsyCallError(message, { status, retryable });
}

async function pushTrackingItem(store, item) {
  const receiptPath = `/shops/${store.shopId}/receipts/${item.receiptId}`;

  // Pushing twice would add a second shipment, so check whether Etsy already has this code.
  const existing = await etsyCall(store, receiptPath);
  if (existing.status === 200) {
    const shipments = existing.json?.shipments || [];
    if (shipments.some((s) => String(s.tracking_code || "").trim() === item.trackingCode)) {
      return { already: true };
    }
  } else if (existing.status === 404) {
    throw new EtsyCallError(`Receipt ${item.receiptId} not found on Etsy shop ${store.shopId}`, {
      status: 404,
      retryable: false,
    });
  } else if (existing.status === 429 || existing.status >= 500) {
    throw failureFor(existing.status, existing.json);
  }

  const created = await etsyCall(store, `${receiptPath}/tracking`, {
    method: "POST",
    body: {
      tracking_code: item.trackingCode,
      carrier_name: item.carrierName || "other",
      send_bcc: false,
    },
  });
  if (created.status >= 200 && created.status < 300) return { already: false };
  throw failureFor(created.status, created.json);
}

// ─── The hourly push ─────────────────────────────────────────────────────────

async function reportResults(results) {
  if (results.length === 0) return;
  await sellfernFetch("/stores/etsy/tracking-queue/results", { method: "POST", body: { results } });
}

export async function runTrackingPush({ manual = false } = {}) {
  if (pushRunning) return { ok: true, skipped: "already running" };
  pushRunning = true;

  const summary = { pushed: 0, failed: 0, already: 0 };
  try {
    const { apiToken } = await storageGet("apiToken");
    if (!apiToken) return { ok: false, error: "No API token configured" };

    const queue = await sellfernFetch("/stores/etsy/tracking-queue");
    const stores = queue?.stores || [];

    for (const store of stores) {
      const results = [];
      for (const item of store.items) {
        try {
          await ensureFreshToken(store);
          const outcome = await pushTrackingItem(store, item);
          results.push({ queueId: item.queueId, success: true });
          if (outcome.already) summary.already += 1;
          else summary.pushed += 1;
        } catch (err) {
          const retryable = err instanceof EtsyCallError ? err.retryable : true;
          results.push({ queueId: item.queueId, success: false, error: err.message, retryable });
          summary.failed += 1;
          // A dead token will fail every other item of this store the same way.
          if (err instanceof EtsyCallError && !err.retryable && /refresh|Reconnect/i.test(err.message)) {
            const rest = store.items.slice(store.items.indexOf(item) + 1);
            rest.forEach((r) => {
              results.push({ queueId: r.queueId, success: false, error: err.message, retryable: false });
              summary.failed += 1;
            });
            break;
          }
        }
        await jitter(600, 1800);
      }
      await reportResults(results);
      await jitter(1000, 3000);
    }

    if (summary.pushed || summary.failed || summary.already) {
      await addLog(
        summary.failed ? "warning" : "success",
        `Etsy tracking: ${summary.pushed} pushed, ${summary.already} already on Etsy, ${summary.failed} failed`
      );
    }
    await storageSet({ etsyTrackingStatus: { ok: true, time: Date.now(), manual, ...summary } });
    return { ok: true, ...summary };
  } catch (err) {
    await addLog("error", `Etsy tracking push failed: ${err.message}`);
    await storageSet({ etsyTrackingStatus: { ok: false, time: Date.now(), manual, error: err.message } });
    return { ok: false, error: err.message };
  } finally {
    pushRunning = false;
  }
}

// ─── Registration (call once from the service worker's top level) ────────────

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (existing) return;
  // Random first run so extensions installed together do not fire in the same minute.
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1 + Math.random() * 4,
    periodInMinutes: PUSH_PERIOD_MINUTES,
  });
}

export function registerEtsyTracking() {
  const callbackFilter = { url: [{ hostEquals: ETSY_CALLBACK_HOST, pathEquals: ETSY_CALLBACK_PATH }] };

  chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.frameId === 0) handleCallbackNavigation(details.url, details.tabId);
  }, callbackFilter);

  // Fallback for browsers that skip onBeforeNavigate when the target refuses the connection.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = changeInfo.url || tab?.pendingUrl || tab?.url;
    if (url) handleCallbackNavigation(url, tabId);
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) runTrackingPush();
  });

  chrome.runtime.onInstalled.addListener(ensureAlarm);
  chrome.runtime.onStartup.addListener(ensureAlarm);
  ensureAlarm();
}
