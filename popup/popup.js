// popup/popup.js — Login + Main scraper flow

let scrapedOrders = [];
let currentUser = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  bindLoginEvents();
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
    autoDetectShopId();
  } else {
    showView("login");
  }
}

// ─── View switching ───────────────────────────────────────────────────────────

function showView(name) {
  document.getElementById("view-login").style.display =
    name === "login" ? "flex" : "none";
  document.getElementById("view-main").style.display =
    name === "main" ? "flex" : "none";

  if (name === "main" && currentUser) {
    const badge = document.getElementById("user-badge");
    if (badge) badge.textContent = currentUser;
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

      const url =
        (apiUrl || "https://api.vconnect.global/api/v2") + "/auth/login";

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
      if (data.needsOrgSelection && data.organizations?.length > 0) {
        // Auto-select first org
        const orgRes = await fetch(
          (apiUrl || "https://api.vconnect.global/api/v2") +
            "/auth/select-organization",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${data.token}`,
            },
            body: JSON.stringify({ organizationId: data.organizations[0].id }),
          },
        );
        const orgData = await orgRes.json().catch(() => ({}));
        if (orgRes.ok && orgData.token) {
          await saveAuth(orgData.token, orgData.user?.email || email);
        } else {
          throw new Error(orgData.error || "Organization selection failed.");
        }
      } else if (data.token) {
        await saveAuth(data.token, data.user?.email || email);
      } else {
        throw new Error("No token received from server.");
      }

      currentUser = email;
      showView("main");
      loadMainPrefs();
      autoDetectShopId();
    } catch (err) {
      showLoginError(err.message);
    } finally {
      setLoginLoading(false);
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

async function saveAuth(token, email) {
  await storage.set({ authToken: token, userEmail: email });
}

// ─── Logout ───────────────────────────────────────────────────────────────────

document.getElementById("btn-logout").addEventListener("click", async () => {
  await storage.set({ authToken: "", userEmail: "" });
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

async function autoDetectShopId() {
  if (getEl("input-shopid").value) return;
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.url?.includes("etsy.com")) return;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        for (const s of document.querySelectorAll("script")) {
          const m = s.textContent.match(/"business_id"\s*:\s*(\d+)/);
          if (m) return m[1];
        }
        const m = window.location.href.match(/\/shop\/(\d+)\//);
        return m ? m[1] : "";
      },
    });
    if (result?.result) getEl("input-shopid").value = result.result;
  } catch (_) {}
}

// ─── Main events ──────────────────────────────────────────────────────────────

function bindMainEvents() {
  getEl("btn-scrape").addEventListener("click", onScrape);
  getEl("btn-push").addEventListener("click", onPush);
  getEl("btn-clear").addEventListener("click", clearPreview);

  // Persist shop ID
  getEl("input-shopid").addEventListener("change", () => {
    storage.set({ shopId: getEl("input-shopid").value.trim() });
  });
  getEl("input-store").addEventListener("change", () => {
    storage.set({ defaultStore: getEl("input-store").value.trim() });
  });

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
      setStatus("error", "❌", "Please navigate to any Etsy page first.");
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
      setStatus("error", "⚠️", "No open orders found for this shop.");
      return;
    }

    renderPreview(scrapedOrders);
    setStatus(
      "success",
      "✅",
      `${scrapedOrders.length} / ${response.total} orders fetched.`,
    );
    getEl("btn-push").disabled = false;
  } catch (err) {
    setStatus("error", "❌", `Error: ${err.message}`);
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
        );
        scrapedOrders = [];
        clearPreview();
        getEl("btn-push").disabled = true;
      } else {
        setStatus(
          "error",
          "❌",
          `Push failed: ${response?.error || "Unknown error"}`,
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

function setStatus(type, icon, text) {
  const box = getEl("status-box");
  box.className = "status-box " + (type !== "info" ? type : "");
  getEl("status-icon").textContent = icon;
  getEl("status-text").textContent = text;
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
