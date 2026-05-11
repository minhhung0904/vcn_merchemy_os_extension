// settings/settings.js

const $ = (id) => document.getElementById(id);

// ─── Load ────────────────────────────────────────────────────────────────────

chrome.storage.local.get(
  ["authToken", "userEmail", "defaultStore", "shopId"],
  (data) => {
    $("default-store").value = data.defaultStore || "";
    $("default-shopid").value = data.shopId || "";

    if (data.authToken) {
      $("user-row-loggedin").style.display = "flex";
      $("user-row-loggedout").style.display = "none";
      $("s-user-email").textContent = data.userEmail || "Unknown";
    } else {
      $("user-row-loggedin").style.display = "none";
      $("user-row-loggedout").style.display = "flex";
    }
  },
);

// ─── Save ────────────────────────────────────────────────────────────────────

$("btn-save").addEventListener("click", () => {
  chrome.storage.local.set(
    {
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

// ─── Sign Out ────────────────────────────────────────────────────────────────

$("btn-signout").addEventListener("click", () => {
  chrome.storage.local.set({ authToken: "", refreshToken: "", userEmail: "" }, () => {
    $("user-row-loggedin").style.display = "none";
    $("user-row-loggedout").style.display = "flex";
    $("s-user-email").textContent = "—";
  });
});

$("btn-goto-login").addEventListener("click", () => window.close());
