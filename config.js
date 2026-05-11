// config.js - Shared configuration for the extension

// Export for ES6 modules (background.js)
export const DEFAULT_API_URL = "https://api.sellfern.com/api/v2";
// export const DEFAULT_API_URL = "http://localhost:3000/api/v2";

// Also make it available globally for non-module scripts (popup.js, settings.js)
if (typeof window !== 'undefined') {
  window.DEFAULT_API_URL = DEFAULT_API_URL;
}
