// settings/settings.js

const $ = (id) => document.getElementById(id);

const DEFAULT_API_URL = window.DEFAULT_API_URL || "http://localhost:3000/api/v2";

// ─── Load ────────────────────────────────────────────────────────────────────

chrome.storage.local.get(
  ["apiToken", "defaultStore", "shopId"],
  (data) => {
    $("api-token").value = data.apiToken || "";
    $("default-store").value = data.defaultStore || "";
    $("default-shopid").value = data.shopId || "";
  },
);

// ─── Show / hide token ───────────────────────────────────────────────────────

$("btn-token-eye").addEventListener("click", () => {
  const input = $("api-token");
  const hidden = input.type === "password";
  input.type = hidden ? "text" : "password";
  $("btn-token-eye").textContent = hidden ? "🙈" : "👁";
});

// ─── Test Connection ─────────────────────────────────────────────────────────

$("btn-test-connection").addEventListener("click", async () => {
  const statusEl = $("conn-status");
  const token = $("api-token").value.trim();

  if (!token) {
    statusEl.className = "conn-status err";
    statusEl.textContent = "🔴 Please enter an API token first.";
    return;
  }

  statusEl.className = "conn-status loading";
  statusEl.textContent = "⏳ Testing…";

  try {
    const res = await fetch(`${DEFAULT_API_URL}/auth/me`, {
      method: "GET",
      headers: { "x-api-key": token },
    });
    const response = await res.json().catch(() => ({}));

    if (!res.ok || !response.success) {
      throw new Error(response.error?.message || response.error || `HTTP ${res.status}`);
    }

    const user = response.data?.user || response.data || {};
    const label = user.organizationName || user.organization_name || user.email || "your organization";
    statusEl.className = "conn-status ok";
    statusEl.textContent = `🟢 Connected — ${label}`;
  } catch (err) {
    statusEl.className = "conn-status err";
    statusEl.textContent = `🔴 ${err.message || "Connection failed."}`;
  }
});

// ─── Save ────────────────────────────────────────────────────────────────────

$("btn-save").addEventListener("click", () => {
  chrome.storage.local.set(
    {
      apiToken: $("api-token").value.trim(),
      defaultStore: $("default-store").value.trim(),
      shopId: $("default-shopid").value.trim(),
    },
    () => {
      $("save-status").textContent = "✅ Saved!";
      setTimeout(() => {
        $("save-status").textContent = "";
      }, 2000);
    },
  );
});
