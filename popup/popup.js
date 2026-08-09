// popup/popup.js — Login + Main scraper flow

const DEFAULT_API_URL = window.DEFAULT_API_URL || "http://localhost:3000/api/v2";

let scrapedOrders = [];
let lastSavedSettings = {};
let isCancelling = false;
let currentAction = null;
let selectedPlatform = 'etsy';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_ORDER_STATES = [
  { id: '', label: 'New' },
  { id: '', label: 'Completed' }
];

// Etsy keeps using its original keys (defaultStore/shopId) for backward
// compatibility with existing installs; Shopify gets its own keys so
// switching platform tabs doesn't clobber the other platform's saved store.
function storeKey() { return selectedPlatform === 'shopify' ? 'shopifyStoreName' : 'defaultStore'; }
function shopIdKey() { return selectedPlatform === 'shopify' ? 'shopifyHandle' : 'shopId'; }

function applyPlatformUI() {
  const isShopify = selectedPlatform === 'shopify';
  const labelText = getEl('store-info-text');
  if (labelText) labelText.textContent = isShopify ? 'Shopify Store Info' : 'Etsy Store Info';
  const shopifyHint = getEl('shopify-hint');
  if (shopifyHint) shopifyHint.style.display = isShopify ? 'block' : 'none';
  const storeMapSection = getEl('shopify-store-map');
  if (storeMapSection) storeMapSection.style.display = isShopify ? 'block' : 'none';
  const orderStateSection = getEl('section-order-state');
  if (orderStateSection) orderStateSection.style.display = isShopify ? 'none' : 'block';
  const orderStateShopifySection = getEl('section-order-state-shopify');
  if (orderStateShopifySection) orderStateShopifySection.style.display = isShopify ? 'block' : 'none';
  const autosyncSection = getEl('section-autosync');
  if (autosyncSection) autosyncSection.style.display = isShopify ? 'none' : 'block';
  const autosyncShopifySection = getEl('section-autosync-shopify');
  if (autosyncShopifySection) autosyncShopifySection.style.display = isShopify ? 'block' : 'none';
  loadMainPrefs();
  if (isShopify) {
    storage.get(['shopifyStoreName']).then(({ shopifyStoreName }) => {
      if (shopifyStoreName) renderShopifyMapViewMode(shopifyStoreName);
      else openShopifyMapEditMode();
    });
  }
}

// ─── Shopify → Sellfern store mapping (view/edit, like the Settings token) ──

function showShopifyMapMode(mode) {
  const viewEl = getEl('shopify-map-view');
  const editEl = getEl('shopify-map-edit');
  if (viewEl) viewEl.style.display = mode === 'view' ? 'flex' : 'none';
  if (editEl) editEl.style.display = mode === 'edit' ? 'flex' : 'none';
}

function renderShopifyMapViewMode(name) {
  const el = getEl('shopify-map-view-name');
  if (el) el.textContent = name || '— no store mapped yet —';
  showShopifyMapMode('view');
}

async function openShopifyMapEditMode() {
  await loadShopifyStoreOptions();
  const select = getEl('select-shopify-store');
  const btnSave = getEl('btn-save-shopify-map');
  if (btnSave) btnSave.disabled = !select?.value;
  showShopifyMapMode('edit');
}

// Populate the "Map to Sellfern Store" dropdown from GET /stores (platform=shopify).
// The browser-detected handle (e.g. "vcn-4") is only a technical identifier used to
// call the Shopify internal API — it won't necessarily match the store's display
// name registered in Sellfern, so the merchant must explicitly map the two.
async function loadShopifyStoreOptions() {
  const select = getEl('select-shopify-store');
  if (!select) return;

  const { apiToken } = await storage.get(['apiToken']);
  if (!apiToken) {
    select.innerHTML = '<option value="">-- Configure API Token first --</option>';
    return;
  }

  select.innerHTML = '<option value="">-- Loading... --</option>';
  try {
    const res = await fetch(DEFAULT_API_URL + '/stores', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiToken },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const response = await res.json();
    const stores = response.success ? response.data : response;
    const shopifyStores = (stores || []).filter(s => s.platform?.toLowerCase() === 'shopify');

    select.innerHTML = '<option value="">-- Select a Sellfern store --</option>';
    shopifyStores.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.name;
      opt.textContent = s.name;
      select.appendChild(opt);
    });

    const { shopifyStoreName } = await storage.get(['shopifyStoreName']);
    if (shopifyStoreName && shopifyStores.some(s => s.name === shopifyStoreName)) {
      select.value = shopifyStoreName;
    }
  } catch (e) {
    select.innerHTML = '<option value="">-- Failed to load list, click Refresh --</option>';
  }
}

// ─── Shopify order state ────────────────────────────────────────────────────
// A single "Order State" dropdown, same UX as Etsy's. Each option maps to the
// underlying filter fields content/shopify.js applies client-side (there's no
// stable savedViewId we could reuse across merchants — see content/shopify.js
// for why). The labels match the default saved-view tabs on Shopify's own
// Orders page (All / Unfulfilled / Unpaid / Open / Archived).
const SHOPIFY_ORDER_STATES = {
  all:         { orderStatus: 'any',    financialStatus: 'any',     fulfillmentStatus: 'any' },
  unfulfilled: { orderStatus: 'any',    financialStatus: 'any',     fulfillmentStatus: 'UNFULFILLED' },
  unpaid:      { orderStatus: 'any',    financialStatus: 'PENDING', fulfillmentStatus: 'any' },
  open:        { orderStatus: 'OPEN',   financialStatus: 'any',     fulfillmentStatus: 'any' },
  archived:    { orderStatus: 'CLOSED', financialStatus: 'any',     fulfillmentStatus: 'any' },
};

function getShopifyFilters() {
  const state = getEl('select-order-state-shopify')?.value || 'unfulfilled';
  return SHOPIFY_ORDER_STATES[state] || SHOPIFY_ORDER_STATES.all;
}

// ─── Shopify Auto-Sync card ─────────────────────────────────────────────────
// Same view/edit + Daily/Hourly pattern as Etsy's auto-sync card, but backed
// by its own storage keys (shopify*) and its own alarm ("autoSyncShopify" in
// background.js) so the two platforms can run on independent schedules.

function bindShopifyAutoSyncCard() {
  const toggleAutoSync = getEl("toggle-autosync-shopify");
  if (!toggleAutoSync) return;

  const btnSaveSync = getEl("btn-save-sync-shopify");
  const optionsDiv = getEl("autosync-options-shopify");
  const modeSelect = getEl("sync-mode-shopify");
  const hoursInput = getEl("sync-hours-shopify");
  const timeWrap = getEl("sync-time-wrap-shopify");
  const hoursWrap = getEl("sync-hours-wrap-shopify");

  const th = getEl("sync-time-h-shopify"), tm = getEl("sync-time-m-shopify");
  const sh = getEl("sync-start-h-shopify"), sm = getEl("sync-start-m-shopify");

  [th, sh].forEach(sel => {
    sel.innerHTML = "";
    for (let i = 0; i < 24; i++) {
      const opt = document.createElement("option");
      const val = i.toString();
      opt.value = val;
      opt.textContent = i.toString().padStart(2, "0");
      sel.appendChild(opt);
    }
  });

  [tm, sm].forEach(sel => {
    sel.innerHTML = "";
    for (let i = 0; i < 60; i++) {
      const opt = document.createElement("option");
      const val = i.toString().padStart(2, "0");
      opt.value = val;
      opt.textContent = val;
      sel.appendChild(opt);
    }
  });

  const to24h = (h, m) => `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  const from24h = (str24) => {
    if (!str24) return { h: "0", m: "00" };
    const [hh, mm] = str24.split(":");
    return { h: parseInt(hh, 10).toString(), m: mm };
  };

  let lastSavedShopifySync = {};

  const displayWrapper = getEl("autosync-display-shopify");
  const editorWrapper = getEl("autosync-editor-shopify");

  const openEditor = () => {
    if (displayWrapper) displayWrapper.style.display = "none";
    if (editorWrapper) editorWrapper.style.display = "flex";
  };
  const closeEditor = () => {
    if (editorWrapper) editorWrapper.style.display = "none";
    if (displayWrapper) displayWrapper.style.display = "flex";
  };

  const btnEditSync = getEl("btn-edit-sync-shopify");
  if (btnEditSync) btnEditSync.addEventListener("click", openEditor);

  const btnCancelSync = getEl("btn-cancel-sync-shopify");
  if (btnCancelSync) {
    btnCancelSync.addEventListener("click", () => {
      toggleAutoSync.checked = lastSavedShopifySync.autoSyncEnabled === true;
      modeSelect.value = lastSavedShopifySync.syncMode || "daily";
      hoursInput.value = lastSavedShopifySync.syncHours || "4";

      const tTime = from24h(lastSavedShopifySync.syncTime || "00:00");
      th.value = tTime.h; tm.value = tTime.m;

      const sTime = from24h(lastSavedShopifySync.syncStartTime || "00:00");
      sh.value = sTime.h; sm.value = sTime.m;

      updateSyncUI();
      closeEditor();
    });
  }

  storage.get(["shopifyAutoSyncEnabled", "shopifySyncMode", "shopifySyncTime", "shopifySyncHours", "shopifySyncStartTime"]).then((res) => {
    toggleAutoSync.checked = res.shopifyAutoSyncEnabled === true;
    modeSelect.value = res.shopifySyncMode || "daily";
    hoursInput.value = res.shopifySyncHours || "4";

    const tTime = from24h(res.shopifySyncTime || "00:00");
    th.value = tTime.h; tm.value = tTime.m;

    const sTime = from24h(res.shopifySyncStartTime || "00:00");
    sh.value = sTime.h; sm.value = sTime.m;

    updateLastSaved();
    updateSyncUI();
  });

  function updateLastSaved() {
    lastSavedShopifySync = {
      autoSyncEnabled: toggleAutoSync.checked,
      syncMode: modeSelect.value,
      syncTime: to24h(th.value, tm.value),
      syncHours: hoursInput.value,
      syncStartTime: to24h(sh.value, sm.value),
    };
    checkChanges();
  }

  function checkChanges() {
    const current = {
      autoSyncEnabled: toggleAutoSync.checked,
      syncMode: modeSelect.value,
      syncTime: to24h(th.value, tm.value),
      syncHours: hoursInput.value,
      syncStartTime: to24h(sh.value, sm.value),
    };
    const hasChanged = JSON.stringify(current) !== JSON.stringify(lastSavedShopifySync);
    btnSaveSync.disabled = !hasChanged;
  }

  function updateSyncUI() {
    const isEnabled = toggleAutoSync.checked;
    btnSaveSync.style.display = "block";
    if (optionsDiv) optionsDiv.style.display = isEnabled ? "block" : "none";

    const card = getEl("sync-card-shopify");
    if (card) {
      if (isEnabled) card.classList.add("active");
      else card.classList.remove("active");
    }

    if (modeSelect.value === "daily") {
      timeWrap.style.display = "flex";
      hoursWrap.style.display = "none";
    } else {
      timeWrap.style.display = "none";
      hoursWrap.style.display = "flex";
    }

    const displaySummary = getEl("autosync-summary-shopify");
    if (displaySummary) {
      if (!isEnabled) {
        displaySummary.textContent = "OFF";
      } else if (modeSelect.value === "daily") {
        displaySummary.textContent = `ON (Daily at ${to24h(th.value, tm.value)})`;
      } else {
        displaySummary.textContent = `ON (Every ${hoursInput.value} hours from ${to24h(sh.value, sm.value)})`;
      }
    }

    checkChanges();
  }

  function saveSyncConfig() {
    const current = {
      autoSyncEnabled: toggleAutoSync.checked,
      syncMode: modeSelect.value,
      syncTime: to24h(th.value, tm.value),
      syncHours: hoursInput.value,
      syncStartTime: to24h(sh.value, sm.value),
    };

    return storage.set({
      shopifyAutoSyncEnabled: current.autoSyncEnabled,
      shopifySyncMode: current.syncMode,
      shopifySyncTime: current.syncTime,
      shopifySyncHours: parseInt(current.syncHours, 10) || 4,
      shopifySyncStartTime: current.syncStartTime,
    }).then(() => {
      lastSavedShopifySync = { ...current };
      chrome.runtime.sendMessage({ type: "UPDATE_ALARM" }).catch(() => {});
    });
  }

  [toggleAutoSync, modeSelect, hoursInput, th, tm, sh, sm].forEach(el => {
    el.addEventListener("change", () => {
      updateSyncUI();
      checkChanges();

      if (el === toggleAutoSync) {
        storage.set({ shopifyAutoSyncEnabled: toggleAutoSync.checked }).then(() => {
          chrome.runtime.sendMessage({ type: "UPDATE_ALARM" }).catch(() => {});
        });
      }
    });
  });

  hoursInput.addEventListener("input", checkChanges);

  btnSaveSync.addEventListener("click", () => {
    btnSaveSync.disabled = true;
    btnSaveSync.textContent = "Saving...";
    saveSyncConfig().then(() => {
      setTimeout(() => {
        btnSaveSync.innerHTML = "<span>💾</span> Save Settings";
        checkChanges();
        closeEditor();
      }, 800);
      setStatus("success", "✅", "Shopify Auto-Sync configuration saved successfully.", true);
    });
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  storage.get(["theme"]).then(res => {
    if (res.theme === "light") {
      document.body.classList.add("light-theme");
      const themeBtn = document.getElementById("btn-theme-toggle");
      if (themeBtn) themeBtn.checked = true;
    }
  });

  bindSettingsEvents();
  bindMainEvents();
  checkAuth();
});

// Always land on the main view; Settings is reachable via the ⚙ button.
async function checkAuth() {
  showView("main");
  const { apiToken, orgName } = await storage.get(["apiToken", "orgName"]);
  updateConfigState(apiToken, orgName);
  applyPlatformUI();
  forceDetectShopInfo(true);
}

// Toggle the config banner + footer status based on whether the token is set.
function updateConfigState(apiToken, orgName) {
  const configured = !!apiToken;
  const banner = getEl("setup-banner");
  if (banner) banner.style.display = configured ? "none" : "flex";
  const apiStatus = getEl("api-status");
  if (apiStatus) {
    apiStatus.textContent = configured
      ? `🟢 ${orgName || "API Token configured"}`
      : "🔴 Not configured — click Settings";
  }
}

// ─── View switching ───────────────────────────────────────────────────────────

function showView(name) {
  document.getElementById("view-main").style.display =
    name === "main" ? "flex" : "none";
  document.getElementById("view-settings").style.display =
    name === "settings" ? "flex" : "none";
}

// ─── In-popup Settings ────────────────────────────────────────────────────────

// The token that most recently passed a Test Connection, plus its org label.
// Save is only allowed for a token that matches settingsTestedToken.
let settingsTestedToken = null;
let settingsOrgLabel = "";
// The currently saved token/org (what View mode displays).
let settingsSavedToken = "";
let settingsSavedOrg = "";

// Pull the organization NAME out of an /auth/me response, tolerating the
// various shapes the API may use. Never falls back to email.
function extractOrgName(response) {
  const d = response?.data ?? response ?? {};
  const u = d.user ?? {};
  const candidates = [
    d.organizationName, d.organization_name, d.orgName,
    d.organization?.name, d.organization?.title, d.organization?.displayName,
    d.org?.name, d.org?.title,
    u.organizationName, u.organization_name, u.orgName,
    u.organization?.name, u.organization?.title, u.organization?.displayName,
    u.org?.name, u.org?.title,
  ];
  const found = candidates.find((v) => typeof v === "string" && v.trim());
  return found ? found.trim() : "";
}

function setSaveEnabled(enabled) {
  const btnSave = getEl("set-btn-save");
  if (btnSave) btnSave.disabled = !enabled;
}

function maskToken(t) {
  if (!t) return "";
  if (t.length <= 8) return "••••••••";
  return `${t.slice(0, 3)}${"•".repeat(8)}${t.slice(-4)}`;
}

function showSettingsMode(mode) {
  getEl("settings-view-mode").style.display = mode === "view" ? "flex" : "none";
  getEl("settings-edit-mode").style.display = mode === "edit" ? "flex" : "none";
}

// Render the read-only View mode from the saved token/org.
function renderSettingsViewMode() {
  getEl("view-org-name").textContent = settingsSavedOrg || "your organization";
  getEl("view-token-mask").textContent = maskToken(settingsSavedToken);
  showSettingsMode("view");
}

// Switch into the editable mode. Pass the existing token to prefill (already
// validated → Save enabled), or "" for a fresh entry (Save locked until test).
function enterSettingsEditMode(token) {
  const input = getEl("set-api-token");
  input.value = token || "";
  input.type = "password";
  getEl("set-btn-token-eye").textContent = "👁";
  getEl("set-conn-status").className = "conn-status";
  getEl("set-conn-status").textContent = "";
  getEl("set-save-status").className = "save-status";
  getEl("set-save-status").textContent = "";

  if (token) {
    settingsTestedToken = token;
    settingsOrgLabel = settingsSavedOrg;
    setSaveEnabled(true);
  } else {
    settingsTestedToken = null;
    settingsOrgLabel = "";
    setSaveEnabled(false);
  }
  showSettingsMode("edit");
}

function openSettingsView() {
  storage.get(["apiToken", "orgName"]).then((data) => {
    settingsSavedToken = data.apiToken || "";
    settingsSavedOrg = data.orgName || "";

    if (settingsSavedToken) {
      renderSettingsViewMode();   // configured → read-only view first
    } else {
      enterSettingsEditMode("");  // first-time → straight to edit
    }
    showView("settings");
  });
}

function bindSettingsEvents() {
  // Back → main view
  const btnBack = getEl("btn-settings-back");
  if (btnBack) btnBack.addEventListener("click", () => checkAuth());

  // Enter edit mode from view mode
  const btnEdit = getEl("set-btn-edit");
  if (btnEdit) btnEdit.addEventListener("click", () => enterSettingsEditMode(settingsSavedToken));

  // Cancel editing → back to view mode if a token is saved, else back to main
  const btnCancel = getEl("set-btn-cancel");
  if (btnCancel) {
    btnCancel.addEventListener("click", () => {
      if (settingsSavedToken) renderSettingsViewMode();
      else checkAuth();
    });
  }

  // Show / hide token
  const btnEye = getEl("set-btn-token-eye");
  if (btnEye) {
    btnEye.addEventListener("click", () => {
      const input = getEl("set-api-token");
      const hidden = input.type === "password";
      input.type = hidden ? "text" : "password";
      btnEye.textContent = hidden ? "🙈" : "👁";
    });
  }

  // Editing the token invalidates any previous test → must re-test before saving
  const tokenInput = getEl("set-api-token");
  if (tokenInput) {
    tokenInput.addEventListener("input", () => {
      const token = tokenInput.value.trim();
      if (token !== settingsTestedToken) {
        setSaveEnabled(false);
        const statusEl = getEl("set-conn-status");
        statusEl.className = "conn-status";
        statusEl.textContent = token ? "Test connection to enable Save." : "";
        getEl("set-save-status").textContent = "";
      }
    });
  }

  // Test connection
  const btnTest = getEl("set-btn-test");
  if (btnTest) {
    btnTest.addEventListener("click", async () => {
      const statusEl = getEl("set-conn-status");
      const token = getEl("set-api-token").value.trim();

      if (!token) {
        statusEl.className = "conn-status err";
        statusEl.textContent = "🔴 Please enter an API token first.";
        setSaveEnabled(false);
        return;
      }

      statusEl.className = "conn-status loading";
      statusEl.textContent = "⏳ Testing…";
      setSaveEnabled(false);

      try {
        const res = await fetch(`${DEFAULT_API_URL}/auth/me`, {
          method: "GET",
          headers: { "x-api-key": token },
        });
        const response = await res.json().catch(() => ({}));

        if (!res.ok || !response.success) {
          throw new Error(response.error?.message || response.error || `HTTP ${res.status}`);
        }

        const orgName = extractOrgName(response);
        if (!orgName) {
          console.warn("[Settings] Could not find org name in /auth/me response:", response);
        }
        const label = orgName || "your organization";

        settingsTestedToken = token;
        settingsOrgLabel = label;
        statusEl.className = "conn-status ok";
        statusEl.textContent = `🟢 Connected — ${label}`;
        setSaveEnabled(true);
      } catch (err) {
        settingsTestedToken = null;
        settingsOrgLabel = "";
        statusEl.className = "conn-status err";
        statusEl.textContent = `🔴 ${err.message || "Connection failed."}`;
        setSaveEnabled(false);
      }
    });
  }

  // Save (only enabled after a successful test)
  const btnSave = getEl("set-btn-save");
  if (btnSave) {
    btnSave.addEventListener("click", async () => {
      const token = getEl("set-api-token").value.trim();
      const statusEl = getEl("set-save-status");

      if (!token || token !== settingsTestedToken) {
        statusEl.className = "save-status err";
        statusEl.textContent = "⚠️ Test connection successfully before saving.";
        setSaveEnabled(false);
        return;
      }

      await storage.set({ apiToken: token, orgName: settingsOrgLabel });
      settingsSavedToken = token;
      settingsSavedOrg = settingsOrgLabel;
      renderSettingsViewMode();   // back to read-only view showing the org
    });
  }

  // Remove API Token (two-step confirm to avoid accidental removal)
  const btnRemove = getEl("set-btn-remove");
  let removeArmed = false;
  let removeTimer = null;
  const resetRemoveBtn = () => {
    removeArmed = false;
    if (removeTimer) clearTimeout(removeTimer);
    if (btnRemove) {
      btnRemove.classList.remove("confirm");
      btnRemove.textContent = "🗑 Remove API Token";
    }
  };
  if (btnRemove) {
    btnRemove.addEventListener("click", async () => {
      // First click arms the confirm; auto-resets after a few seconds
      if (!removeArmed) {
        removeArmed = true;
        btnRemove.classList.add("confirm");
        btnRemove.textContent = "⚠️ Click again to confirm";
        removeTimer = setTimeout(resetRemoveBtn, 3000);
        return;
      }

      resetRemoveBtn();
      await storage.remove(["apiToken", "orgName"]);
      settingsSavedToken = "";
      settingsSavedOrg = "";
      settingsTestedToken = null;
      settingsOrgLabel = "";
      enterSettingsEditMode("");   // drop into empty edit mode to add a new one
      getEl("set-save-status").textContent = "🗑 API Token removed.";
    });
  }
}

// ─── Logging Utility ────────────────────────────────────────────────────────
async function addSystemLog(type, message) {
  const { systemLogs = [] } = await storage.get(["systemLogs"]);
  systemLogs.unshift({ time: new Date().toISOString(), type, message });
  if (systemLogs.length > 50) systemLogs.pop();
  await storage.set({ systemLogs });
}

// ─── Main prefs ───────────────────────────────────────────────────────────────

async function loadMainPrefs() {
  getEl("input-store").value = "";
  getEl("input-shopid").value = "";

  if (selectedPlatform === "shopify") {
    const { shopifyStoreName, shopifyHandle, shopifyOrderState } = await storage.get([
      "shopifyStoreName", "shopifyHandle", "shopifyOrderState",
    ]);
    // input-store always mirrors the store detected in the browser (like Etsy) —
    // the Sellfern mapping is a separate concept, held by the dropdown below.
    if (shopifyHandle) {
      getEl("input-store").value = shopifyHandle;
      getEl("input-shopid").value = shopifyHandle;
    }
    if (shopifyStoreName) {
      isStoreRegistered(shopifyStoreName).then(registered => {
        updateStoreWarningUI(shopifyStoreName, registered);
      });
    } else {
      updateStoreWarningUI("", false);
    }

    const stateSelect = getEl("select-order-state-shopify");
    if (stateSelect) stateSelect.value = shopifyOrderState || "unfulfilled";
    return;
  }

  const { defaultStore, shopId, orderStates, completedTimeframe } = await storage.get([
    "defaultStore",
    "shopId",
    "orderStates",
    "completedTimeframe"
  ]);
  if (defaultStore) {
    getEl("input-store").value = defaultStore;
    isStoreRegistered(defaultStore).then(registered => {
      updateStoreWarningUI(defaultStore, registered);
    });
  } else {
    updateStoreWarningUI("", false);
  }
  if (shopId) getEl("input-shopid").value = shopId;
  if (completedTimeframe) {
    const tf = getEl("select-timeframe");
    if (tf) tf.value = completedTimeframe;
  }
  
  // Use defaults if none saved, but filter to only show "New" and "Completed"
  const statesToRender = (orderStates && orderStates.length > 0) ? orderStates : DEFAULT_ORDER_STATES;
  const newState = statesToRender.find(s => s.label?.toLowerCase().includes("new"));
  const selectedId = newState ? newState.id : statesToRender[0]?.id;
  renderOrderStates(statesToRender, selectedId);
  storage.set({ orderStateId: selectedId });
}

function renderOrderStates(states, selectedId) {
  const select = getEl("select-order-state");
  if (!select) return;
  
  // Reset select options
  select.innerHTML = '';
  
  // Filter for only New and Completed labels (case-insensitive)
  const allowedLabels = ['new', 'completed'];
  const filteredStates = states.filter(s => 
    allowedLabels.some(label => s.label.toLowerCase().includes(label))
  );

  let selectedApplied = false;
  filteredStates.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.label;
    if (!selectedApplied && String(s.id) === String(selectedId)) {
      opt.selected = true;
      selectedApplied = true;
    }
    select.appendChild(opt);
  });
  
  select.dispatchEvent(new Event("change"));
}
 
function updateStoreWarningUI(storeName, registered) {
  const warningIcon = document.getElementById("store-warning-icon");
  const btnRecheck = document.getElementById("btn-recheck-store");
  const btnScrape = document.getElementById("btn-scrape");
  const warningTextNode = document.getElementById("store-warning-text");
  const warningMessage = document.getElementById("store-warning-message");
  const warningStoreName = document.getElementById("warning-store-name");
  const hasStore = Boolean(storeName);

  const noStoreHint = selectedPlatform === "shopify"
    ? "Please open your Shopify Admin, click Auto Detect, then map it to a Sellfern store below."
    : "Please open Etsy and click Auto Detect to get store information.";

  if (warningIcon) {
    warningIcon.style.display = (hasStore && registered) ? "none" : "inline";
    warningIcon.title = hasStore
      ? `WARNING: Store "${storeName}" is NOT found in Sellfern. Please add it first!`
      : noStoreHint;
  }
  if (btnRecheck) {
    btnRecheck.style.display = (!hasStore || registered) ? "none" : "inline";
  }
  if (btnScrape) {
    btnScrape.disabled = !hasStore || !registered;
  }
  if (warningTextNode) {
    warningTextNode.style.display = (!hasStore || !registered) ? "block" : "none";
    if (warningMessage) {
      warningMessage.textContent = hasStore
        ? `🚨 WARNING: Store "${storeName}" is NOT found in Sellfern. Please add it first!`
        : `🚨 ${noStoreHint}`;
    }
    if (warningStoreName) warningStoreName.textContent = storeName;
  }
}

async function isStoreRegistered(storeName) {
  if (!storeName) return false;
  try {
    const { apiToken } = await storage.get(["apiToken"]);
    if (!apiToken) return true; // Not configured yet — don't block the UI here

    const url = DEFAULT_API_URL + "/stores";
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiToken
      }
    });

    if (!res.ok) return true; // If API fails, allow to avoid blocking
    const response = await res.json();
    const stores = response.success ? response.data : response;
    return stores.some(s => s.name?.toLowerCase() === storeName.toLowerCase() && s.platform?.toLowerCase() === selectedPlatform);
  } catch (e) {
    console.error("Failed to check store existence:", e);
    return true; // Allow if network fails
  }
}

async function forceDetectShopInfo(silent = false) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const needle = selectedPlatform === "shopify" ? "admin.shopify.com" : "etsy.com";
    if (!tab?.url?.includes(needle)) {
      if (!silent) {
        const msg = selectedPlatform === "shopify"
          ? "Please navigate to your Shopify Admin to detect shop info."
          : "Please navigate to Etsy to detect shop info.";
        setStatus("error", "❌", msg, true);
      }
      return;
    }

    if (selectedPlatform === "shopify") {
      await autoDetectShopifyHandleActiveTab();
    } else {
      await autoDetectShopIdActiveTab();
    }
  } catch (err) {
    if (!silent) setStatus("error", "❌", "Failed to detect shop info.", true);
  }
}

// Shopify: detect the store handle directly from the admin.shopify.com URL
// (…/store/<handle>/…) and show it in the Store Info box, same as Etsy does.
// This is just the technical identifier used to call the Shopify internal
// API — it's NOT assumed to be the store's display name in Sellfern, so the
// merchant still maps the two explicitly via the dropdown below.
async function autoDetectShopifyHandleActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const m = tab?.url?.match(/\/store\/([^/]+)\//);
    if (!m) {
      setStatus("error", "❌", "Could not detect Shopify store handle from this URL.", true);
      return;
    }
    const handle = m[1];
    getEl("input-shopid").value = handle;
    getEl("input-store").value = handle;
    await storage.set({ shopifyHandle: handle });

    const { shopifyStoreName } = await storage.get(["shopifyStoreName"]);
    if (shopifyStoreName) {
      const registered = await isStoreRegistered(shopifyStoreName);
      updateStoreWarningUI(shopifyStoreName, registered);
      renderShopifyMapViewMode(shopifyStoreName);
      setStatus("info", "🔍", "Open the Orders page, let it finish loading, then click Fetch Orders.");
    } else {
      updateStoreWarningUI("", false);
      await openShopifyMapEditMode();
      setStatus("info", "🔍", `Detected "${handle}". Please select the matching store in Sellfern below.`);
    }
  } catch (err) {
    setStatus("error", "❌", "Failed to detect Shopify store handle.", true);
  }
}


async function autoDetectShopIdActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes("etsy.com")) {
      const currentStore = getEl("input-store").value.trim();
      if (currentStore) {
        const isRegistered = await isStoreRegistered(currentStore);
        updateStoreWarningUI(currentStore, isRegistered);
      }
      setStatus("error", "❌", "Cannot detect. Please log into Etsy first.", true);
      return;
    }
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Robust detection logic from content/etsy.js
        function getShopId() {
          const metaShopId = document.querySelector('meta[name="shop-id"]');
          if (metaShopId?.content) return metaShopId.content;

          try {
            const globals = window.__reactPageGlobals || window.__page_globals || {};
            if (globals.shop_id) return String(globals.shop_id);
            if (globals.business_id) return String(globals.business_id);
          } catch (_) {}

          try {
            if (window.etsy?.Session?.shopId) return String(window.etsy.Session.shopId);
          } catch (_) {}

          const mcLinks = Array.from(document.querySelectorAll('a[href*="mission-control"], script'))
            .map(el => el.href || el.src || el.textContent || '')
            .join(' ');
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

        const shopId = getShopId();
        let storeName = "";
        try {
          const globals = window.__reactPageGlobals || window.__page_globals || {};
          if (globals.shop_name) storeName = String(globals.shop_name);
        } catch (_) {}
        if (!storeName) {
           const scripts = document.querySelectorAll('script');
           for (const s of scripts) {
             const nameM = s.textContent.match(/"shop_name"\s*:\s*"([^"]+)"/);
             if (nameM) { storeName = nameM[1]; break; }
           }
        }

        return { shopId, storeName };
      },
    });
    
    if (result?.result) {
      const { shopId, storeName } = result.result;
      if (shopId) {
        getEl("input-shopid").value = shopId;
        storage.set({ shopId });
      }
      if (storeName) {
        getEl("input-store").value = storeName;
        storage.set({ defaultStore: storeName });
      }

      // Fetch order states (ensure content script is injected first)
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/etsy.js"]
      }).catch(() => {});

      chrome.tabs.sendMessage(tab.id, { type: "GET_ORDER_STATES" }, (resp) => {
        if (resp?.ok && resp.states) {
          // Identify New and Completed states from response and update our defaults
          const statesToSave = [...DEFAULT_ORDER_STATES];
          
          const detectedNew = resp.states.find(s => s.label.toLowerCase().includes('new'));
          if (detectedNew) {
            const newState = statesToSave.find(s => s.label === 'New');
            if (newState) newState.id = detectedNew.id;
          }
          
          const detectedCompleted = resp.states.find(s => s.label.toLowerCase().includes('completed'));
          if (detectedCompleted) {
            const completedState = statesToSave.find(s => s.label === 'Completed');
            if (completedState) completedState.id = detectedCompleted.id;
          }

          // Auto-select "New" if found
          const selectedId = detectedNew ? detectedNew.id : (detectedCompleted ? detectedCompleted.id : statesToSave[0].id);

          renderOrderStates(statesToSave, selectedId);
          storage.set({ 
            orderStates: statesToSave,
            orderStateId: selectedId
          });
        }
      });

      const currentStore = getEl("input-store").value.trim();
      let isRegistered = true;
      if (currentStore) {
        isRegistered = await isStoreRegistered(currentStore);
        updateStoreWarningUI(currentStore, isRegistered);
      } else {
        updateStoreWarningUI("", false);
      }

      if (!shopId && !storeName) {
        setStatus("error", "❌", "Could not find shop info on this page.", true);
      } else {
        setStatus("info", "🔍", "Navigate to any Etsy page, then click Fetch Orders.");
      }
    }
  } catch (err) {
    const currentStore = getEl("input-store").value.trim();
    if (currentStore) {
      const isRegistered = await isStoreRegistered(currentStore);
      updateStoreWarningUI(currentStore, isRegistered);
    }
    setStatus("error", "❌", "Failed to detect shop info.", true);
  }
}

// ─── View switching ──────────────────────────────────────────────────────────────

function bindMainEvents() {
  getEl("btn-scrape").addEventListener("click", onScrape);
  getEl("btn-push").addEventListener("click", onPush);
  getEl("btn-clear").addEventListener("click", clearPreview);
  
  const btnCancelAction = getEl("btn-cancel-action");
  if (btnCancelAction) {
    btnCancelAction.addEventListener("click", () => {
      if (isCancelling) return;
      isCancelling = true;
      btnCancelAction.textContent = "Cancelling...";
      btnCancelAction.disabled = true;

      if (currentAction === "scrape") {
        chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
          if (tab) {
            chrome.tabs.sendMessage(tab.id, { type: "CANCEL_SCRAPE" });
            setStatus("loading", "⏳", "Cancelling scrape process...");
          }
        });
      } else if (currentAction === "push") {
        chrome.runtime.sendMessage({ type: "CANCEL_PUSH" });
        setStatus("loading", "⏳", "Cancelling push process...");
      }
    });
  }

  getEl("btn-detect-shop").addEventListener("click", async () => {
    const btn = getEl("btn-detect-shop");
    btn.textContent = "Detecting...";
    await forceDetectShopInfo(false);
    btn.textContent = "Auto Detect";
  });
  
  const btnRecheck = getEl("btn-recheck-store");
  if (btnRecheck) {
    btnRecheck.addEventListener("click", async () => {
      // For Shopify, input-store shows the browser-detected handle, not the
      // mapped Sellfern store name — read the actual mapping from storage.
      const storeName = selectedPlatform === "shopify"
        ? (await storage.get(["shopifyStoreName"])).shopifyStoreName || ""
        : getEl("input-store").value.trim();
      if (!storeName) return;
      btnRecheck.textContent = "Checking...";
      btnRecheck.disabled = true;
      
      const registered = await isStoreRegistered(storeName);
      updateStoreWarningUI(storeName, registered);
      
      if (registered) {
        setStatus("success", "✅", `Store "${storeName}" checked successfully!`, true);
      }
      
      btnRecheck.textContent = "Re-check";
      btnRecheck.disabled = false;
    });
  }

  getEl("select-order-state").addEventListener("change", (e) => {
    const orderStateId = e.target.value;
    storage.set({ orderStateId });
  });

  // Open Settings (to change the API token)
  const btnOpenSettingsMain = getEl("btn-open-settings-main");
  if (btnOpenSettingsMain) {
    btnOpenSettingsMain.addEventListener("click", () => {
      openSettingsView();
    });
  }

  // Whole config banner is clickable → open Settings
  const setupBanner = getEl("setup-banner");
  if (setupBanner) {
    setupBanner.addEventListener("click", () => {
      openSettingsView();
    });
  }

  // Persist shop ID
  getEl("input-shopid").addEventListener("change", () => {
    storage.set({ [shopIdKey()]: getEl("input-shopid").value.trim() });
  });
  getEl("input-store").addEventListener("change", async () => {
    const storeName = getEl("input-store").value.trim();
    storage.set({ [storeKey()]: storeName });
    if (storeName) {
      const registered = await isStoreRegistered(storeName);
      updateStoreWarningUI(storeName, registered);

      setStatus("info", "🔍", defaultHint());
    } else {
      updateStoreWarningUI("", false);
    }
  });

  // Shopify: map the browser-detected store to a store registered in Sellfern.
  // Same view/edit + explicit Save pattern as the API Token settings above.
  const selectShopifyStore = getEl("select-shopify-store");
  const btnSaveShopifyMap = getEl("btn-save-shopify-map");
  const btnCancelShopifyMap = getEl("btn-cancel-shopify-map");
  const btnEditShopifyMap = getEl("btn-edit-shopify-map");

  if (selectShopifyStore) {
    selectShopifyStore.addEventListener("change", () => {
      if (btnSaveShopifyMap) btnSaveShopifyMap.disabled = !selectShopifyStore.value;
    });
  }

  if (btnSaveShopifyMap) {
    btnSaveShopifyMap.addEventListener("click", async () => {
      const name = selectShopifyStore.value;
      if (!name) return;
      await storage.set({ shopifyStoreName: name });
      updateStoreWarningUI(name, true); // guaranteed registered — came from the Sellfern store list itself
      renderShopifyMapViewMode(name);
      setStatus("success", "✅", `Mapped to store "${name}".`, true);
    });
  }

  if (btnCancelShopifyMap) {
    btnCancelShopifyMap.addEventListener("click", async () => {
      const { shopifyStoreName } = await storage.get(["shopifyStoreName"]);
      renderShopifyMapViewMode(shopifyStoreName);
    });
  }

  if (btnEditShopifyMap) {
    btnEditShopifyMap.addEventListener("click", () => openShopifyMapEditMode());
  }

  const btnRefreshShopifyStores = getEl("btn-refresh-shopify-stores");
  if (btnRefreshShopifyStores) {
    btnRefreshShopifyStores.addEventListener("click", () => loadShopifyStoreOptions());
  }

  const selectOrderStateShopify = getEl("select-order-state-shopify");
  if (selectOrderStateShopify) {
    selectOrderStateShopify.addEventListener("change", (e) => {
      storage.set({ shopifyOrderState: e.target.value });
    });
  }

  getEl("select-order-state").addEventListener("change", (e) => {
    storage.set({ orderStateId: e.target.value });
    const selectedOpt = e.target.options[e.target.selectedIndex];
    const isCompleted = selectedOpt && (selectedOpt.textContent.toLowerCase().includes("completed") || selectedOpt.textContent.toLowerCase().includes("finish"));
    const tfGroup = getEl("timeframe-group");
    if (tfGroup) {
      if (isCompleted && e.isTrusted) {
        getEl("select-timeframe").value = "last_30_days";
        storage.set({ completedTimeframe: "last_30_days" });
      }
      tfGroup.style.display = isCompleted ? "block" : "none";
    }
  });

  getEl("select-timeframe").addEventListener("change", (e) => {
    storage.set({ completedTimeframe: e.target.value });
  });

  // Persist auto-sync setting
  const toggleAutoSync = getEl("toggle-autosync");
  const btnSaveSync = getEl("btn-save-sync");
  const optionsDiv = getEl("autosync-options");
  const modeSelect = getEl("sync-mode");
  const hoursInput = getEl("sync-hours");
  const timeWrap = getEl("sync-time-wrap");
  const hoursWrap = getEl("sync-hours-wrap");

  // Time selections
  const th = getEl("sync-time-h"), tm = getEl("sync-time-m");
  const sh = getEl("sync-start-h"), sm = getEl("sync-start-m");

  // Populate hour selects 00-23
  [th, sh].forEach(sel => {
    sel.innerHTML = "";
    for (let i = 0; i < 24; i++) {
      const opt = document.createElement("option");
      const val = i.toString();
      opt.value = val;
      opt.textContent = i.toString().padStart(2, "0");
      sel.appendChild(opt);
    }
  });

  // Populate minute selects 00-59
  [tm, sm].forEach(sel => {
    sel.innerHTML = "";
    for (let i = 0; i < 60; i++) {
      const opt = document.createElement("option");
      const val = i.toString().padStart(2, "0");
      opt.value = val;
      opt.textContent = val;
      sel.appendChild(opt);
    }
  });

  const to24h = (h, m) => {
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  };

  const from24h = (str24) => {
    if (!str24) return { h: "0", m: "00" };
    const [hh, mm] = str24.split(":");
    return { h: parseInt(hh, 10).toString(), m: mm };
  };

  if (toggleAutoSync) {
    const displayWrapper = getEl("autosync-display");
    const editorWrapper = getEl("autosync-editor");

    const openEditor = () => {
      if (displayWrapper) displayWrapper.style.display = "none";
      if (editorWrapper) editorWrapper.style.display = "flex";
    };

    const closeEditor = () => {
      if (editorWrapper) editorWrapper.style.display = "none";
      if (displayWrapper) displayWrapper.style.display = "flex";
    };

    const btnEditSync = getEl("btn-edit-sync");
    if (btnEditSync) btnEditSync.addEventListener("click", openEditor);

    const btnCancelSync = getEl("btn-cancel-sync");
    if (btnCancelSync) {
      btnCancelSync.addEventListener("click", () => {
        if (!lastSavedSettings) { closeEditor(); return; }
        toggleAutoSync.checked = lastSavedSettings.autoSyncEnabled === true;
        modeSelect.value = lastSavedSettings.syncMode || "daily";
        hoursInput.value = lastSavedSettings.syncHours || "4";
        
        const tTime = from24h(lastSavedSettings.syncTime || "00:00");
        th.value = tTime.h; tm.value = tTime.m;
        
        const sTime = from24h(lastSavedSettings.syncStartTime || "00:00");
        sh.value = sTime.h; sm.value = sTime.m;
        
        updateSyncUI();
        closeEditor();
      });
    }

    storage.get(["autoSyncEnabled", "syncMode", "syncTime", "syncHours", "syncStartTime"]).then((res) => {
      toggleAutoSync.checked = res.autoSyncEnabled === true;
      modeSelect.value = res.syncMode || "daily";
      hoursInput.value = res.syncHours || "4";

      const tTime = from24h(res.syncTime || "00:00");
      th.value = tTime.h; tm.value = tTime.m;

      const sTime = from24h(res.syncStartTime || "00:00");
      sh.value = sTime.h; sm.value = sTime.m;

      updateLastSaved();
      updateSyncUI();
    });

    function updateLastSaved() {
      lastSavedSettings = {
        shopId: getEl("input-shopid").value.trim(),
        defaultStore: getEl("input-store").value.trim(),
        autoSyncEnabled: toggleAutoSync.checked,
        syncMode: modeSelect.value,
        syncTime: to24h(th.value, tm.value),
        syncHours: hoursInput.value,
        syncStartTime: to24h(sh.value, sm.value)
      };
      checkChanges();
    }

    function checkChanges() {
      const current = {
        shopId: getEl("input-shopid").value.trim(),
        defaultStore: getEl("input-store").value.trim(),
        autoSyncEnabled: toggleAutoSync.checked,
        syncMode: modeSelect.value,
        syncTime: to24h(th.value, tm.value),
        syncHours: hoursInput.value,
        syncStartTime: to24h(sh.value, sm.value)
      };
      
      const hasChanged = JSON.stringify(current) !== JSON.stringify(lastSavedSettings);
      btnSaveSync.disabled = !hasChanged;
    }

    function updateSyncUI() {
      const isEnabled = toggleAutoSync.checked;
      btnSaveSync.style.display = "block";
      if (optionsDiv) optionsDiv.style.display = isEnabled ? "block" : "none";
      
      const card = getEl("sync-card");
      if (card) {
        if (isEnabled) card.classList.add("active");
        else card.classList.remove("active");
      }
      
      if (modeSelect.value === "daily") {
        timeWrap.style.display = "flex";
        hoursWrap.style.display = "none";
      } else {
        timeWrap.style.display = "none";
        hoursWrap.style.display = "flex";
      }

      const displaySummary = getEl("autosync-summary");
      if (displaySummary) {
        if (!isEnabled) {
          displaySummary.textContent = "OFF";
        } else {
          if (modeSelect.value === "daily") {
             displaySummary.textContent = `ON (Daily at ${to24h(th.value, tm.value)})`;
          } else {
             displaySummary.textContent = `ON (Every ${hoursInput.value} hours from ${to24h(sh.value, sm.value)})`;
          }
        }
      }

      checkChanges();
    }

    function saveSyncConfig() {
      const current = {
        shopId: getEl("input-shopid").value.trim(),
        defaultStore: getEl("input-store").value.trim(),
        autoSyncEnabled: toggleAutoSync.checked,
        syncMode: modeSelect.value,
        syncTime: to24h(th.value, tm.value),
        syncHours: hoursInput.value, // Keep as string for comparison
        syncStartTime: to24h(sh.value, sm.value)
      };
      
      const p = storage.set({
        ...current,
        syncHours: parseInt(current.syncHours, 10) || 4 // Save as number for backend logic
      }).then(() => {
        lastSavedSettings = { ...current };
        chrome.runtime.sendMessage({ type: "UPDATE_ALARM" }).catch(() => {});
      });
      return p;
    }

    [toggleAutoSync, modeSelect, hoursInput, th, tm, sh, sm].forEach(el => {
      el.addEventListener("change", () => {
        updateSyncUI();
        checkChanges();
        
        // Immediate save for the toggle itself to ensure persistence even if Save button is hidden
        if (el === toggleAutoSync) {
          storage.set({ autoSyncEnabled: toggleAutoSync.checked }).then(() => {
            chrome.runtime.sendMessage({ type: "UPDATE_ALARM" }).catch(() => {});
          });
        }
      });
    });
    
    [getEl("input-shopid"), getEl("input-store"), hoursInput].forEach(el => {
      el.addEventListener("input", checkChanges);
    });
    
    btnSaveSync.addEventListener("click", () => {
      btnSaveSync.disabled = true;
      btnSaveSync.textContent = "Saving...";
      saveSyncConfig().then(() => {
        setTimeout(() => { 
          btnSaveSync.innerHTML = "<span>💾</span> Save Settings"; 
          checkChanges(); // Re-check after text change to ensure button goes back to disabled
          closeEditor();
        }, 800);
        setStatus("success", "✅", "Auto-Sync configuration saved successfully.", true);
      });
    });
  }

  bindShopifyAutoSyncCard();

  // Platform tabs
  document.querySelectorAll(".platform-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.classList.contains("active")) return;
      document
        .querySelectorAll(".platform-tab")
        .forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      selectedPlatform = tab.dataset.platform;
      clearPreview();
      applyPlatformUI();
    });
  });

  // Theme Toggle
  const btnTheme = getEl("btn-theme-toggle");
  if (btnTheme) {
    btnTheme.addEventListener("change", (e) => {
      const isLight = e.target.checked;
      if (isLight) document.body.classList.add("light-theme");
      else document.body.classList.remove("light-theme");
      storage.set({ theme: isLight ? "light" : "dark" });
    });
  }

  // Progress from background / content script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "FETCH_PROGRESS") {
      const pct =
        msg.total > 0 ? Math.round((msg.fetched / msg.total) * 100) : 0;
      updateProgress(pct, `Fetching ${msg.fetched}/${msg.total}…`);
    }
    if (msg.type === "PUSH_PROGRESS") {
      const pct = Math.round((msg.pushed / msg.total) * 100);
      updateProgress(pct, `Uploading ${msg.pushed}/${msg.total}…`);
    }
  });

  // Logs event
  const btnLogs = getEl("btn-logs");
  const logsSection = getEl("logs-section");
  const logsList = getEl("logs-list");
  
  if (btnLogs && logsSection && logsList) {
    btnLogs.addEventListener("click", async () => {
      const isHidden = logsSection.style.display === "none";
      logsSection.style.display = isHidden ? "block" : "none";
      if (isHidden) {
        // load logs
        const { systemLogs = [] } = await storage.get(["systemLogs"]);
        logsList.innerHTML = "";
        if (!systemLogs.length) {
          logsList.innerHTML = "<li>No log data available.</li>";
        } else {
          systemLogs.forEach(lg => {
             const li = document.createElement("li");
             const timeStr = new Date(lg.time).toLocaleString('en-US');
             let colorLine = "#ccc";
             if (lg.type === "error") colorLine = "#ff6b6b";
             if (lg.type === "success") colorLine = "#51cf66";
             li.style.color = colorLine;
             li.style.marginBottom = "4px";
             li.style.borderBottom = "1px solid #333";
             li.style.paddingBottom = "4px";
             li.innerHTML = `<strong>[${timeStr}]</strong> ${lg.message}`;
             logsList.appendChild(li);
          });
        }
      }
    });
  }
}

// ─── Scrape ───────────────────────────────────────────────────────────────────

async function onScrape() {
  const { apiToken } = await storage.get(["apiToken"]);
  if (!apiToken) {
    setStatus("error", "⚙️", "API Token not configured. Open Settings to enter your token before fetching orders.", true);
    return;
  }

  if (selectedPlatform === "shopify") {
    await onScrapeShopify();
    return;
  }

  setStatus("loading", "⏳", "Connecting to Etsy API…");
  getEl("btn-scrape").disabled = true;
  showProgress('scrape');

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab?.url?.includes("etsy.com")) {
      setStatus("error", "❌", "Please navigate to any Etsy page first.", true);
      return;
    }

    const shopId = getEl("input-shopid").value.trim();
    const storeName = getEl("input-store").value.trim();
    const orderStateId = getEl("select-order-state").value;
    const selectedOpt = getEl("select-order-state").options[getEl("select-order-state").selectedIndex];
    const orderStateLabel = selectedOpt ? selectedOpt.textContent : '';
    const timeframeValue = getEl("select-timeframe") ? getEl("select-timeframe").value : 'last_90_days';

    if (!orderStateId) {
      setStatus("error", "❌", "Please auto-detect store info before fetching orders.", true);
      getEl("btn-scrape").disabled = false;
      return;
    }

    if (storeName) {
      const registered = await isStoreRegistered(storeName);
      if (!registered) {
        const errMsg = `Store "${storeName}" is not in this organization. Please contact your admin to add this store before pushing to Sellfern.`;
        setStatus("error", "❌", errMsg, true);
        addSystemLog("error", `[Manual Scrape] ` + errMsg);
        return;
      }
    }

    await chrome.scripting
      .executeScript({
        target: { tabId: tab.id },
        files: ["content/etsy.js"],
      })
      .catch(() => {});

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "SCRAPE_ETSY_ORDERS",
      shopId,
      storeName,
      orderStateId,
      orderStateLabel,
      timeframeValue,
    });

    if (!response?.ok) throw new Error(response?.error || "Scrape failed");

    scrapedOrders = response.orders;

    const isCompletedTab = orderStateLabel.toLowerCase().includes('completed') || orderStateLabel.toLowerCase().includes('finish');
    const timeInfo = isCompletedTab ? `, Time: ${timeframeValue}` : '';

    if (scrapedOrders.length === 0) {
      setStatus("error", "⚠️", "No orders found for this shop.", true);
      addSystemLog("info", `[Scrape] Fetched 0 orders (Tab: ${orderStateLabel}${timeInfo})`);
      return;
    }

    renderPreview(scrapedOrders);
    
    if (isCancelling) {
      setStatus("info", "⚠️", `Scrape cancelled. Fetched ${scrapedOrders.length} orders.`, true);
      addSystemLog("info", `[Scrape] Cancelled. Fetched ${scrapedOrders.length} orders (Tab: ${orderStateLabel}${timeInfo})`);
    } else {
      setStatus("success", "✅", `${scrapedOrders.length} / ${response.total} orders fetched.`, true);
      addSystemLog("info", `[Scrape] Successfully fetched ${scrapedOrders.length}/${response.total} orders (Tab: ${orderStateLabel}${timeInfo})`);
    }

    getEl("btn-push").disabled = false;
  } catch (err) {
    setStatus("error", "❌", `Error: ${err.message}`, true);
    addSystemLog("error", `[Manual Scrape] Scrape error: ${err.message}`);
  } finally {
    getEl("btn-scrape").disabled = false;
    hideProgress();
  }
}

async function onScrapeShopify() {
  setStatus("loading", "⏳", "Reading orders from Shopify…");
  getEl("btn-scrape").disabled = true;
  showProgress('scrape');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url?.includes("admin.shopify.com")) {
      setStatus("error", "❌", "Please navigate to your Shopify Orders page first.", true);
      return;
    }

    const shopHandle = getEl("input-shopid").value.trim();
    // Read the saved mapping from storage, not the <select> element — that
    // element is only populated while the "Map to Sellfern Store" card is in
    // Edit mode, so it's empty whenever the popup opens straight into View
    // mode (the normal case once a mapping has already been saved).
    const { shopifyStoreName } = await storage.get(["shopifyStoreName"]);
    const storeName = (shopifyStoreName || "").trim();

    if (!shopHandle) {
      setStatus("error", "❌", "Please click Auto Detect on your Shopify Orders page first.", true);
      return;
    }

    if (!storeName) {
      setStatus("error", "❌", "Please map this store to a Sellfern store first (see \"Map to Sellfern Store\" above).", true);
      return;
    }

    const registered = await isStoreRegistered(storeName);
    if (!registered) {
      const errMsg = `Store "${storeName}" is not in this organization. Please contact your admin to add this store before pushing to Sellfern.`;
      setStatus("error", "❌", errMsg, true);
      addSystemLog("error", `[Manual Scrape] ` + errMsg);
      return;
    }

    const filters = getShopifyFilters();

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "SCRAPE_SHOPIFY_ORDERS",
      shopHandle,
      storeName,
      filters,
    });

    if (!response?.ok) throw new Error(response?.error || "Scrape failed");

    scrapedOrders = response.orders;

    if (scrapedOrders.length === 0) {
      setStatus("error", "⚠️", "No orders found for this shop.", true);
      addSystemLog("info", `[Scrape] Fetched 0 Shopify orders`);
      return;
    }

    renderPreview(scrapedOrders);
    setStatus("success", "✅", `${scrapedOrders.length} orders fetched.`, true);
    addSystemLog("info", `[Scrape] Successfully fetched ${scrapedOrders.length} Shopify orders`);
    getEl("btn-push").disabled = false;
  } catch (err) {
    let hint = "";
    if (/No live Shopify order query captured/.test(err.message)) {
      hint = " Please reload the Orders page and try again.";
    } else if (/Could not establish connection/.test(err.message)) {
      hint = " The content script isn't loaded on this tab (this happens after the extension is reloaded) — please reload the Shopify tab and try again.";
    }
    setStatus("error", "❌", `Error: ${err.message}${hint}`, true);
    addSystemLog("error", `[Manual Scrape] Shopify scrape error: ${err.message}`);
  } finally {
    getEl("btn-scrape").disabled = false;
    hideProgress();
  }
}

// ─── Push ─────────────────────────────────────────────────────────────────────

async function onPush() {
  if (!scrapedOrders.length) return;

  getEl("btn-push").disabled = true;
  getEl("btn-scrape").disabled = true;
  showProgress('push');
  setStatus(
    "loading",
    "🚀",
    `Pushing ${scrapedOrders.length} orders to Sellfern…`,
  );

  chrome.runtime.sendMessage(
    { type: "PUSH_ORDERS", orders: scrapedOrders },
    (response) => {
      hideProgress();
      if (response?.ok) {
        const pushedCount = response.result?.pushed || 0;
        
        if (isCancelling && pushedCount < scrapedOrders.length) {
          scrapedOrders = scrapedOrders.slice(pushedCount);
          renderPreview(scrapedOrders);
          setStatus("info", "⚠️", `Push cancelled. Pushed ${pushedCount} orders.`, true);
          addSystemLog("info", `[Push] Cancelled. Pushed ${pushedCount} orders.`);
          getEl("btn-push").disabled = false;
        } else {
          scrapedOrders = [];
          clearPreview();
          setStatus("success", "🎉", `Pushed ${pushedCount} orders to Sellfern!`, true);
          addSystemLog("success", `[Push] Successfully pushed ${pushedCount} orders.`);
          getEl("btn-push").disabled = true;
        }
      } else {
        const errMsg = `Push failed: ${response?.error || "Unknown error"}`;
        setStatus("error", "❌", errMsg, true);
        addSystemLog("error", `[Push] ${errMsg}`);
        getEl("btn-push").disabled = false;
      }
      getEl("btn-scrape").disabled = false;
      isCancelling = false;
    },
  );
}

// ─── Preview ──────────────────────────────────────────────────────────────────

function renderPreview(orders) {
  const tbody = getEl("preview-body");
  tbody.innerHTML = "";
  orders.forEach((o, i) => {
    const tr = document.createElement("tr");
    const date = o.date ? o.date.split("T")[0] : "—";
    const sku = o.items[0]?.sku || "—";
    const qty = o.items.reduce((s, it) => s + (it.quantity || 1), 0);
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td title="${o.id}">${o.id}</td>
      <td>${date}</td>
      <td title="${o.customerName}">${trunc(o.customerName, 12)}</td>
      <td title="${sku}">${trunc(sku, 14)}</td>
      <td>${qty}</td>
      <td>$${o.totalAmount.toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  });
  getEl("preview-count").textContent = `${orders.length} order(s)`;
  getEl("preview-section").style.display = "flex";
}

function defaultHint() {
  return selectedPlatform === "shopify"
    ? "Navigate to your Shopify Orders page, then click Fetch Orders."
    : "Navigate to any Etsy page, then click Fetch Orders.";
}

function clearPreview() {
  const tbody = getEl("preview-body");
  if (tbody) tbody.innerHTML = "";
  const sec = getEl("preview-section");
  if (sec) sec.style.display = "none";
  getEl("btn-push").disabled = true;
  setStatus("info", "🔍", defaultHint());
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

let statusTimeout = null;

function setStatus(type, icon, text, autoClear = false) {
  const box = getEl("status-box");
  box.className = "status-box " + (type !== "info" ? type : "");
  getEl("status-icon").textContent = icon;
  getEl("status-text").textContent = text;
  
  if (statusTimeout) {
    clearTimeout(statusTimeout);
    statusTimeout = null;
  }
  
  if (autoClear) {
    statusTimeout = setTimeout(() => {
      setStatus("info", "🔍", defaultHint());
    }, 3000);
  }
}

function showProgress(actionType) {
  isCancelling = false;
  currentAction = actionType;
  const btnCancel = getEl("btn-cancel-action");
  if(btnCancel) {
    btnCancel.textContent = "Cancel";
    btnCancel.disabled = false;
  }
  getEl("progress-wrap").style.display = "flex";
  const spinner = getEl("progress-spinner");
  if (spinner) spinner.classList.add("active");
  updateProgress(0);
}
function hideProgress() {
  const spinner = getEl("progress-spinner");
  if (spinner) spinner.classList.remove("active");
  setTimeout(() => {
    getEl("progress-wrap").style.display = "none";
  }, 1500);
}
function updateProgress(pct, label) {
  getEl("progress-fill").style.width = `${pct}%`;
  getEl("progress-label").textContent = label || `${pct}%`;
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function getEl(id) {
  return document.getElementById(id);
}
function trunc(s, n) {
  return s?.length > n ? s.slice(0, n) + "…" : s || "—";
}

const storage = {
  get: (keys) => new Promise((r) => chrome.storage.local.get(keys, r)),
  set: (data) => new Promise((r) => chrome.storage.local.set(data, r)),
  remove: (keys) => new Promise((r) => chrome.storage.local.remove(keys, r)),
};
