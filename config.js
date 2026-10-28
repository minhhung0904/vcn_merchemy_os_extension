// config.js - Shared configuration for the extension

// Export for ES6 modules (background.js)
export const DEFAULT_API_URL = "https://api.sellfern.com/api/v2";
// export const DEFAULT_API_URL = "http://localhost:3000/api/v2";

// Where Etsy redirects after the shop owner approves access. It must match the redirect URI the
// backend puts in the authorize URL (ETSY_EXTENSION_REDIRECT_URI) and the one registered on the
// Etsy app. Nothing listens on it: the extension reads the URL during navigation.
export const ETSY_CALLBACK_HOST = "localhost";
export const ETSY_CALLBACK_PORT = "8080";
export const ETSY_CALLBACK_PATH = "/callback";

// Also make it available globally for non-module scripts (popup.js, settings.js)
if (typeof window !== 'undefined') {
  window.DEFAULT_API_URL = DEFAULT_API_URL;
}
