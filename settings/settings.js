// settings/settings.js

const DEFAULT_API_URL = 'https://api.vconnect.global/api/v2';

const $ = id => document.getElementById(id);

// ─── Load ────────────────────────────────────────────────────────────────────

chrome.storage.local.get(['apiUrl', 'authToken', 'userEmail', 'defaultStore', 'shopId'], (data) => {
  $('api-url').value         = data.apiUrl       || DEFAULT_API_URL;
  $('default-store').value   = data.defaultStore || '';
  $('default-shopid').value  = data.shopId       || '';

  if (data.authToken) {
    $('user-row-loggedin').style.display  = 'flex';
    $('user-row-loggedout').style.display = 'none';
    $('s-user-email').textContent = data.userEmail || 'Unknown';
  } else {
    $('user-row-loggedin').style.display  = 'none';
    $('user-row-loggedout').style.display = 'flex';
  }
});

// ─── Save ────────────────────────────────────────────────────────────────────

$('btn-save').addEventListener('click', () => {
  chrome.storage.local.set({
    apiUrl:       $('api-url').value.trim()        || DEFAULT_API_URL,
    defaultStore: $('default-store').value.trim(),
    shopId:       $('default-shopid').value.trim(),
  }, () => {
    $('save-status').textContent = '✅ Saved!';
    setTimeout(() => { $('save-status').textContent = ''; }, 2000);
  });
});

// ─── Sign Out ────────────────────────────────────────────────────────────────

$('btn-signout').addEventListener('click', () => {
  chrome.storage.local.set({ authToken: '', userEmail: '' }, () => {
    $('user-row-loggedin').style.display  = 'none';
    $('user-row-loggedout').style.display = 'flex';
    $('s-user-email').textContent = '—';
  });
});

$('btn-goto-login').addEventListener('click', () => window.close());

// ─── Test Connection ─────────────────────────────────────────────────────────

$('btn-test').addEventListener('click', async () => {
  const apiUrl = $('api-url').value.trim() || DEFAULT_API_URL;
  const { authToken } = await new Promise(r => chrome.storage.local.get(['authToken'], r));

  if (!authToken) {
    setStatus('error', '● Not signed in. Please sign in first.');
    return;
  }

  setStatus('loading', '● Testing…');

  try {
    const res = await fetch(`${apiUrl}/stores`, {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    if (res.ok) {
      const data = await res.json().catch(() => []);
      setStatus('ok', `● Connected — ${Array.isArray(data) ? data.length : '?'} store(s) found`);
    } else {
      setStatus('error', `● Error ${res.status}: ${res.statusText}`);
    }
  } catch (err) {
    setStatus('error', `● Cannot reach API: ${err.message}`);
  }
});

function setStatus(type, text) {
  const el = $('conn-status');
  el.className = `conn-status ${type}`;
  el.textContent = text;
}
