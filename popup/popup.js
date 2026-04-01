// popup/popup.js — Login + Main scraper flow

let scrapedOrders = [];
let currentUser = null;
let tempAuthToken = null;
let tempAuthEmail = null;
let lastSavedSettings = {};

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  bindLoginEvents();
  bindOrgEvents();
  bindMainEvents();
  checkAuth();
});

async function checkAuth() {
  const { authToken, userEmail } = await storage.get([
    "authToken",
    "userEmail",
  ]);
  if (authToken) {
    currentUser = userEmail;
    showView("main");
    loadMainPrefs();
    forceDetectShopInfo(true);
  } else {
    showView("login");
  }
}

// ─── View switching ───────────────────────────────────────────────────────────

function showView(name) {
  document.getElementById("view-login").style.display =
    name === "login" ? "flex" : "none";
  document.getElementById("view-org").style.display =
    name === "org" ? "flex" : "none";
  document.getElementById("view-main").style.display =
    name === "main" ? "flex" : "none";

  if (name === "main" && currentUser) {
    const badge = document.getElementById("user-badge");
    if (badge) badge.textContent = currentUser;
    
    storage.get(["activeOrgName"]).then(res => {
      const orgBadge = document.getElementById("org-badge");
      if (orgBadge) orgBadge.textContent = res.activeOrgName || "No Organization";
    });
  }
}

// ─── Login ────────────────────────────────────────────────────────────────────

function bindLoginEvents() {
  const emailEl = document.getElementById("login-email");
  const passEl = document.getElementById("login-password");
  const btnLogin = document.getElementById("btn-login");
  const btnEye = document.getElementById("btn-login-eye");
  const errEl = document.getElementById("login-error");

  // Allow Enter key to submit
  [emailEl, passEl].forEach((el) => {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") btnLogin.click();
    });
  });

  // Show / hide password
  btnEye.addEventListener("click", () => {
    const hidden = passEl.type === "password";
    passEl.type = hidden ? "text" : "password";
    btnEye.textContent = hidden ? "🙈" : "👁";
  });

  btnLogin.addEventListener("click", async () => {
    const email = emailEl.value.trim();
    const password = passEl.value;

    // Validate
    errEl.style.display = "none";
    if (!email || !password) {
      showLoginError("Please enter your email and password.");
      return;
    }

    setLoginLoading(true);

    try {
      const { apiUrl } = await storage.get(["apiUrl"]);

      const url = (apiUrl || "http://localhost:3000/api/v2") + "/auth/login";

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(
          data.error || data.message || `Login failed (${res.status})`,
        );
      }

      // Might require org selection for multi-org accounts
      if (data.tempToken && data.organizations?.length > 1) {
        tempAuthToken = data.tempToken;
        tempAuthEmail = data.user?.email || email;
        
        // Persist for switching later
        await storage.set({ 
          tempAuthToken: data.tempToken, 
          organizations: data.organizations 
        });

        const selectEl = document.getElementById("org-select");
        selectEl.innerHTML = "";
        data.organizations.forEach((org) => {
          const opt = document.createElement("option");
          opt.value = org.id;
          opt.textContent = org.name;
          selectEl.appendChild(opt);
        });
        showView("org");
        return; // Pause login flow until org is selected
      } else if (data.tempToken && data.organizations?.length === 1) {
        // Auto-select first org
        const orgRes = await fetch(
          (apiUrl || "http://localhost:3000/api/v2") +
            "/auth/select-organization",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${data.tempToken}`,
            },
            body: JSON.stringify({ organizationId: data.organizations[0].id }),
          },
        );
        const orgData = await orgRes.json().catch(() => ({}));
        if (orgRes.ok && orgData.token) {
          await saveAuth(orgData.token, orgData.user?.email || data.user?.email || email, data.organizations[0].name);
        } else {
          throw new Error(orgData.error || "Organization selection failed.");
        }
      } else if (data.token) {
        await saveAuth(data.token, data.user?.email || email, "Personal");
      } else {
        throw new Error("No token received from server.");
      }

      currentUser = email;
      showView("main");
      loadMainPrefs();
      forceDetectShopInfo(true);
    } catch (err) {
      showLoginError(err.message);
    } finally {
      setLoginLoading(false);
    }
  });
}

function bindOrgEvents() {
  const btnSelect = document.getElementById("btn-org-select");
  const btnCancel = document.getElementById("btn-org-cancel");
  const selectEl = document.getElementById("org-select");
  const errEl = document.getElementById("org-error");

  btnCancel.addEventListener("click", async () => {
    const { authToken } = await storage.get(["authToken"]);
    if (authToken) {
      showView("main");
    } else {
      tempAuthToken = null;
      tempAuthEmail = null;
      showView("login");
    }
  });

  btnSelect.addEventListener("click", async () => {
    errEl.style.display = "none";
    const orgId = selectEl.value;
    if (!orgId) return;

    btnSelect.disabled = true;
    document.getElementById("btn-org-label").textContent = "Continuing...";

    try {
      const { apiUrl } = await storage.get(["apiUrl"]);
      const orgRes = await fetch(
        (apiUrl || "http://localhost:3000/api/v2") + "/auth/select-organization",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tempAuthToken}`,
          },
          body: JSON.stringify({ organizationId: parseInt(orgId, 10) }),
        },
      );
      
      const orgData = await orgRes.json().catch(() => ({}));
      if (orgRes.ok && orgData.token) {
        const orgName = selectEl.options[selectEl.selectedIndex].text;
        await saveAuth(orgData.token, orgData.user?.email || tempAuthEmail, orgName);
        currentUser = tempAuthEmail;
        tempAuthToken = null;
        tempAuthEmail = null;
        
        showView("main");
        loadMainPrefs();
        forceDetectShopInfo(true);
      } else {
        throw new Error(orgData.error || "Organization selection failed.");
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = "block";
    } finally {
      btnSelect.disabled = false;
      document.getElementById("btn-org-label").textContent = "Continue";
    }
  });
}

function showLoginError(msg) {
  const errEl = document.getElementById("login-error");
  errEl.textContent = msg;
  errEl.style.display = "block";
}

function setLoginLoading(on) {
  const btn = document.getElementById("btn-login");
  const lbl = document.getElementById("btn-login-label");
  btn.disabled = on;
  lbl.textContent = on ? "Signing in…" : "Sign In";
}

async function saveAuth(token, email, orgName) {
  await storage.set({ 
    authToken: token, 
    userEmail: email,
    activeOrgName: orgName 
  });
}

// ─── Logout ───────────────────────────────────────────────────────────────────

document.getElementById("btn-logout").addEventListener("click", async () => {
  await storage.set({ 
    authToken: "", 
    userEmail: "", 
    activeOrgName: "",
    organizations: [],
    tempAuthToken: ""
  });
  currentUser = null;
  scrapedOrders = [];
  clearPreview();
  showView("login");
});

// ─── Main prefs ───────────────────────────────────────────────────────────────

async function loadMainPrefs() {
  const { defaultStore, shopId } = await storage.get([
    "defaultStore",
    "shopId",
  ]);
  if (defaultStore) getEl("input-store").value = defaultStore;
  if (shopId) getEl("input-shopid").value = shopId;
}

async function forceDetectShopInfo(silent = false) {
  try {
    const res = await fetch("https://www.etsy.com/your/shops/me/dashboard", { credentials: "include" });
    const html = await res.text();
    
    let shopId = "";
    let storeName = "";
    
    // Attempt parsing globals
    const globalMatch = html.match(/window\.__page_globals\s*=\s*({.*?});/s);
    if (globalMatch) {
      try {
        const globals = JSON.parse(globalMatch[1]);
        if (globals.shop_id) shopId = String(globals.shop_id);
        if (globals.business_id) shopId = String(globals.business_id);
        if (globals.shop_name) storeName = String(globals.shop_name);
      } catch (e) {}
    }
    
    if (!shopId) {
      const idMatch = html.match(/"shop_id"\s*:\s*(\d+)/) || html.match(/"business_id"\s*:\s*(\d+)/);
      if (idMatch) shopId = idMatch[1];
    }
    if (!storeName) {
      const nameMatch = html.match(/"shop_name"\s*:\s*"([^"]+)"/);
      if (nameMatch) storeName = nameMatch[1];
    }
    
    if (shopId) {
      getEl("input-shopid").value = shopId;
      storage.set({ shopId });
    }
    if (storeName) {
      getEl("input-store").value = storeName;
      storage.set({ defaultStore: storeName });
    }
    
    if (!silent) {
      if (shopId && storeName) {
        setStatus("success", "✅", `Detected: ${storeName} (${shopId})`, true);
      } else if (shopId) {
        setStatus("success", "✅", `Detected Shop ID: ${shopId}`, true);
      } else {
        autoDetectShopIdActiveTab();
      }
    }
  } catch (err) {
    if (!silent) autoDetectShopIdActiveTab();
  }
}

async function autoDetectShopIdActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes("etsy.com")) {
      setStatus("error", "❌", "Cannot detect. Please log into Etsy first.", true);
      return;
    }
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        let shopId = "";
        let storeName = "";
        for (const s of document.querySelectorAll("script")) {
          const idM = s.textContent.match(/"business_id"\s*:\s*(\d+)/) || s.textContent.match(/"shop_id"\s*:\s*(\d+)/);
          if (idM) shopId = idM[1];
          const nameM = s.textContent.match(/"shop_name"\s*:\s*"([^"]+)"/);
          if (nameM) storeName = nameM[1];
        }
        if (!shopId) {
          const m = window.location.href.match(/\/shop\/(\d+)\//);
          if (m) shopId = m[1];
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
      if (shopId || storeName) {
        setStatus("success", "✅", `Detected from tab: ${storeName || "Unknown"} (${shopId || "Unknown"})`, true);
      } else {
        setStatus("error", "❌", "Could not find shop info on this page.", true);
      }
    }
  } catch (err) {
    setStatus("error", "❌", "Failed to detect shop info.", true);
  }
}

// ─── View switching ──────────────────────────────────────────────────────────────

function bindMainEvents() {
  getEl("btn-scrape").addEventListener("click", onScrape);
  getEl("btn-push").addEventListener("click", onPush);
  getEl("btn-clear").addEventListener("click", clearPreview);
  getEl("btn-detect-shop").addEventListener("click", async () => {
    const btn = getEl("btn-detect-shop");
    btn.textContent = "Detecting...";
    await forceDetectShopInfo(false);
    btn.textContent = "Auto Detect";
  });

  // Switch organization
  getEl("btn-switch-org").addEventListener("click", async () => {
    const { organizations, tempAuthToken: storedTempToken } = await storage.get(["organizations", "tempAuthToken"]);
    if (organizations && organizations.length > 0) {
      tempAuthToken = storedTempToken;
      const selectEl = document.getElementById("org-select");
      selectEl.innerHTML = "";
      organizations.forEach((org) => {
        const opt = document.createElement("option");
        opt.value = org.id;
        opt.textContent = org.name;
        selectEl.appendChild(opt);
      });
      showView("org");
    } else {
      setStatus("error", "❌", "No other organizations found. Please re-login.", true);
    }
  });

  // Persist shop ID
  getEl("input-shopid").addEventListener("change", () => {
    storage.set({ shopId: getEl("input-shopid").value.trim() });
  });
  getEl("input-store").addEventListener("change", () => {
    storage.set({ defaultStore: getEl("input-store").value.trim() });
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
    storage.get(["autoSyncEnabled", "syncMode", "syncTime", "syncHours", "syncStartTime"]).then((res) => {
      toggleAutoSync.checked = res.autoSyncEnabled !== false;
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
      optionsDiv.style.display = isEnabled ? "flex" : "none";
      btnSaveSync.style.display = "block";
      
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
          btnSaveSync.textContent = "Save Settings"; 
          checkChanges(); // Re-check after text change to ensure button goes back to disabled
        }, 1000);
        setStatus("success", "✅", "Settings saved successfully.", true);
      });
    });
  }

  // Platform tabs
  document.querySelectorAll(".platform-tab:not(.disabled)").forEach((tab) => {
    tab.addEventListener("click", () => {
      document
        .querySelectorAll(".platform-tab")
        .forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
    });
  });

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
}

// ─── Scrape ───────────────────────────────────────────────────────────────────

async function onScrape() {
  setStatus("loading", "⏳", "Connecting to Etsy API…");
  getEl("btn-scrape").disabled = true;
  showProgress();

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
    });

    if (!response?.ok) throw new Error(response?.error || "Scrape failed");

    scrapedOrders = response.orders;

    if (scrapedOrders.length === 0) {
      setStatus("error", "⚠️", "No open orders found for this shop.", true);
      return;
    }

    renderPreview(scrapedOrders);
    setStatus(
      "success",
      "✅",
      `${scrapedOrders.length} / ${response.total} orders fetched.`,
      true
    );
    getEl("btn-push").disabled = false;
  } catch (err) {
    setStatus("error", "❌", `Error: ${err.message}`, true);
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
  showProgress();
  setStatus(
    "loading",
    "🚀",
    `Pushing ${scrapedOrders.length} orders to Merchemy OS…`,
  );

  chrome.runtime.sendMessage(
    { type: "PUSH_ORDERS", orders: scrapedOrders },
    (response) => {
      hideProgress();
      if (response?.ok) {
        setStatus(
          "success",
          "🎉",
          `Pushed ${response.result.pushed} orders to Merchemy OS!`,
          true
        );
        scrapedOrders = [];
        clearPreview();
        getEl("btn-push").disabled = true;
      } else {
        setStatus(
          "error",
          "❌",
          `Push failed: ${response?.error || "Unknown error"}`,
          true
        );
        getEl("btn-push").disabled = false;
      }
      getEl("btn-scrape").disabled = false;
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

function clearPreview() {
  const tbody = getEl("preview-body");
  if (tbody) tbody.innerHTML = "";
  const sec = getEl("preview-section");
  if (sec) sec.style.display = "none";
  getEl("btn-push").disabled = true;
  setStatus(
    "info",
    "🔍",
    "Ready. Navigate to any Etsy page, then click Fetch Orders.",
  );
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
      setStatus("info", "🔍", "Ready. Navigate to any Etsy page, then click Fetch Orders.");
    }, 3000);
  }
}

function showProgress() {
  getEl("progress-wrap").style.display = "flex";
  updateProgress(0);
}
function hideProgress() {
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
};
