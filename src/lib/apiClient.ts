const TOKEN_KEY = 'pacs_clinical_token';
export function setClinicalToken(token: string | null) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  }
  window.dispatchEvent(new Event('pacs-token-changed'));
}
export function getClinicalToken() {
  const token = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
  if (token && !localStorage.getItem(TOKEN_KEY)) localStorage.setItem(TOKEN_KEY, token);
  return token;
}
export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) { const headers = new Headers(init.headers); const token = getClinicalToken(); if (token) headers.set('Authorization', `Bearer ${token}`); return fetch(input, { ...init, headers }); }
export function sessionFragment() { const token = getClinicalToken(); return token ? `access=${encodeURIComponent(token)}` : ''; }
