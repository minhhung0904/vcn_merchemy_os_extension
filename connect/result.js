const params = new URLSearchParams(location.search);
const ok = params.get("ok") === "1";
document.getElementById("icon").textContent = ok ? "✅" : "⚠️";
document.getElementById("title").textContent = ok ? "Etsy shop connected" : "Etsy connection failed";
document.getElementById("message").textContent = params.get("message") || "";
