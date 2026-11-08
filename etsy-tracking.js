// etsy-tracking.js — pushes tracking numbers to Etsy and finishes the Etsy OAuth connection.
//
// Everything that talks to Etsy runs here, in the browser, so Etsy sees the shop owner's own
// network. Sellfern only keeps the queue and the tokens:
//   1. Connect:  Etsy redirects to http://localhost:8080/callback; we read code+state from that
//                navigation and hand them to Sellfern, which stores the tokens.
//   2. Push:     on a schedule the user sets in the popup (Push Tracking tab: daily at a time, or
//                every N hours from a start time; default every hour, can be turned off) and on demand, we claim the pending rows from Sellfern, call
//                the Etsy API for each one and report the outcome back. Only the Etsy store this
//                extension detected (defaultStore, set by Auto Detect) is pushed.

import { DEFAULT_API_URL, ETSY_CALLBACK_HOST, ETSY_CALLBACK_PORT, ETSY_CALLBACK_PATH } from "./config.js";

const ETSY_API_BASE = "https://openapi.etsy.com/v3/application";
const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const ALARM_NAME = "etsyTrackingPush";
// Auto push settings live in chrome.storage.local under this key. Keep the default in sync with
// ETSY_AUTO_PUSH_DEFAULT in popup/popup.js.
const AUTO_PUSH_KEY = "etsyAutoPush";
const DEFAULT_AUTO_PUSH = { enabled: true, mode: "hourly", time: "00:00", hours: 1, startTime: "00:00" };
// The schedule the current alarm was created from, so a service worker restart keeps it as is.
const SCHEDULED_KEY = "etsyAutoPushScheduled";
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
  if (res.status === 401) {
    throw Object.assign(new Error("Invalid or expired API token. Please update it in the extension Settings."), { status: 401 });
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json?.error?.message || json?.error || json?.message || `Sellfern API error ${res.status}`;
    throw Object.assign(new Error(typeof message === "string" ? message : JSON.stringify(message)), { status: res.status });
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

// Safety stop for a manual run: 200 batches of 50 = 10,000 tracking numbers.
const MAX_MANUAL_BATCHES = 200;

// Pushes one claimed store batch to Etsy, reports the outcome, and adds it to `summary`.
// Returns { rateLimited } so a manual run can stop instead of hammering Etsy.
async function pushStoreBatch(store, summary) {
  const results = [];
  let rateLimited = false;
  for (let i = 0; i < store.items.length; i += 1) {
    const item = store.items[i];
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

      const deadToken = err instanceof EtsyCallError && !err.retryable && /refresh|Reconnect/i.test(err.message);
      const tooFast = err instanceof EtsyCallError && err.status === 429;
      if (deadToken || tooFast) {
        // A dead token fails every other item the same way; after a 429 Etsy wants us to back off.
        // Untouched items go back to the queue (retryable) or fail with the token error.
        const message = tooFast ? "Not sent: Etsy rate limit reached, will retry later" : err.message;
        store.items.slice(i + 1).forEach((r) => {
          results.push({ queueId: r.queueId, success: false, error: message, retryable: tooFast });
          if (!tooFast) summary.failed += 1;
        });
        rateLimited = tooFast;
        break;
      }
    }
    await jitter(600, 1800);
  }
  await reportResults(results);
  return { rateLimited };
}

// On an auto run these mean "this extension is not set up for tracking push" rather than a failure:
// bad token (401), token without the tracking scope or not an admin (403), a Sellfern server that
// does not have the tracking endpoints yet (404). Auto runs skip them without logging every hour.
const NOT_SET_UP_STATUSES = new Set([401, 403, 404]);

// What the popup shows when tracking push is not set up. Kept out of the logs on purpose.
const SETUP_ISSUE_KEY = "etsyTrackingSetupIssue";
const SETUP_MESSAGES = {
  401: "Your API Token is invalid or expired. Update it in Settings.",
  403: "Your API Token cannot push tracking. Use a token of an Admin user that has the orders:status:write scope (Sellfern → Settings → API Tokens), then update it in Settings.",
  404: "This Sellfern server does not support Etsy tracking push yet.",
};

async function setSetupIssue(issue) {
  await storageSet({ [SETUP_ISSUE_KEY]: issue ? { ...issue, time: Date.now() } : null });
}

function sendProgress(progress) {
  chrome.runtime.sendMessage({ type: "ETSY_TRACKING_PROGRESS", ...progress }).catch(() => {});
}

// Auto runs push one batch (up to 50). A manual run keeps claiming batches of the detected store
// until its queue is empty, Etsy rate-limits us, or the safety limit is hit.
export async function runTrackingPush({ manual = false } = {}) {
  if (pushRunning) return { ok: true, skipped: "already running" };
  pushRunning = true;

  const summary = { pushed: 0, failed: 0, already: 0 };
  let storeName = "";
  let stopReason = "";
  try {
    const { apiToken, defaultStore } = await storageGet(["apiToken", "defaultStore"]);
    if (!apiToken) return { ok: false, error: "No API token configured" };
    storeName = String(defaultStore || "").trim();
    if (!storeName) {
      if (!manual) return { ok: true, skipped: "no store detected" };
      throw new Error("No Etsy store detected. Open your Etsy shop and click Auto Detect in the Get Orders tab.");
    }

    let afterId = manual ? 0 : null;
    for (let batch = 1; ; batch += 1) {
      const query = new URLSearchParams({ storeName });
      if (afterId !== null) query.set("afterId", String(afterId));
      const queue = await sellfernFetch(`/stores/etsy/tracking-queue?${query}`);
      if (batch === 1) await setSetupIssue(null); // Sellfern accepted the token and the store
      const stores = queue?.stores || [];

      let rateLimited = false;
      for (const store of stores) {
        ({ rateLimited } = await pushStoreBatch(store, summary));
        if (rateLimited) break;
      }

      if (!manual) break;
      if (rateLimited) { stopReason = "Etsy rate limit reached, the rest stays in the queue"; break; }
      if (!queue?.lastId) break; // nothing left for this store
      if (batch >= MAX_MANUAL_BATCHES) { stopReason = `Stopped after ${batch} batches, click Push now again for the rest`; break; }

      afterId = queue.lastId;
      sendProgress({ storeName, batch, ...summary });
      await jitter(1000, 3000);
    }

    const didWork = summary.pushed || summary.failed || summary.already;
    if (!manual && !didWork) return { ok: true, ...summary };

    if (didWork) {
      await addLog(
        summary.failed || stopReason ? "warning" : "success",
        `Etsy tracking (${storeName}): ${summary.pushed} pushed, ${summary.already} already on Etsy, ${summary.failed} failed${stopReason ? `. ${stopReason}` : ""}`
      );
    }
    await storageSet({ etsyTrackingStatus: { ok: true, time: Date.now(), manual, storeName, stopReason, ...summary } });
    return { ok: true, stopReason, ...summary };
  } catch (err) {
    const didWork = summary.pushed || summary.failed || summary.already;
    if (NOT_SET_UP_STATUSES.has(err.status)) {
      await setSetupIssue({ status: err.status, message: SETUP_MESSAGES[err.status], detail: err.message });
      if (!manual && !didWork) return { ok: true, skipped: err.message };
    }
    await addLog("error", `Etsy tracking push failed: ${err.message}`);
    await storageSet({
      etsyTrackingStatus: { ok: false, time: Date.now(), manual, storeName, error: err.message, ...summary },
    });
    return { ok: false, error: err.message, ...summary };
  } finally {
    pushRunning = false;
  }
}

// ─── Registration (call once from the service worker's top level) ────────────

function parseTime(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  const hh = m ? Number(m[1]) : NaN;
  const mm = m ? Number(m[2]) : NaN;
  if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) return { hh, mm };
  return parseTime(fallback, "00:00");
}

async function getAutoPushSettings() {
  const stored = (await storageGet(AUTO_PUSH_KEY))[AUTO_PUSH_KEY] || {};
  const settings = { ...DEFAULT_AUTO_PUSH, ...stored };
  settings.mode = settings.mode === "daily" ? "daily" : "hourly";
  const hours = Number(settings.hours);
  settings.hours = Number.isInteger(hours) && hours >= 1 && hours <= 24 ? hours : DEFAULT_AUTO_PUSH.hours;
  return settings;
}

// Same rules as setupSyncAlarm in background.js (Get Orders Auto-Sync).
function nextRunFor(settings, now = new Date()) {
  if (settings.mode === "daily") {
    const { hh, mm } = parseTime(settings.time, DEFAULT_AUTO_PUSH.time);
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return { when: next.getTime(), periodInMinutes: 1440 };
  }
  const { hh, mm } = parseTime(settings.startTime, DEFAULT_AUTO_PUSH.startTime);
  const stepMs = settings.hours * 60 * 60 * 1000;
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  while (next.getTime() <= now.getTime()) next.setTime(next.getTime() + stepMs);
  return { when: next.getTime(), periodInMinutes: settings.hours * 60 };
}

// Creates, reschedules or removes the alarm so it matches the auto push settings. Runs on every
// service worker start, so without `force` an alarm made from the same schedule is left alone.
export async function syncTrackingAlarm({ force = false } = {}) {
  const settings = await getAutoPushSettings();
  if (!settings.enabled) {
    await chrome.alarms.clear(ALARM_NAME);
    await storageSet({ [SCHEDULED_KEY]: null });
    return;
  }
  const signature = settings.mode === "daily"
    ? `daily@${settings.time}`
    : `hourly/${settings.hours}@${settings.startTime}`;
  const existing = await chrome.alarms.get(ALARM_NAME);
  const scheduled = (await storageGet(SCHEDULED_KEY))[SCHEDULED_KEY];
  if (!force && existing && scheduled === signature) return;

  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, nextRunFor(settings));
  await storageSet({ [SCHEDULED_KEY]: signature });
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

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    // Guard against an alarm left over from before auto push was turned off.
    if (!(await getAutoPushSettings()).enabled) {
      await chrome.alarms.clear(ALARM_NAME);
      return;
    }
    runTrackingPush();
  });

  chrome.runtime.onInstalled.addListener(syncTrackingAlarm);
  chrome.runtime.onStartup.addListener(syncTrackingAlarm);
  syncTrackingAlarm();
}
