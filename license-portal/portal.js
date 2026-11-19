'use strict';

let csrfToken = '';
let lastLicense = null;
const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Não foi possível concluir a solicitação.');
  if (body.csrf) csrfToken = body.csrf;
  return body;
}

function showApp() { $('login').classList.add('hidden'); $('app').classList.remove('hidden'); }
function showLogin() { csrfToken = ''; $('app').classList.add('hidden'); $('login').classList.remove('hidden'); $('password').value = ''; }

async function checkSession() {
  try {
    const result = await api('/api/session');
    csrfToken = result.csrf;
    showApp();
  } catch { showLogin(); }
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-message').textContent = '';
  try {
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
    csrfToken = result.csrf;
    showApp();
  } catch (error) { $('login-message').textContent = error.message; }
});

$('logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } finally { showLogin(); }
});

$('plan').addEventListener('change', () => {
  const plan = $('plan').value;
  if (plan === 'TRIAL') {
    $('maxStorageGb').value = '100'; $('maxDevices').value = '5';
    const date = new Date(Date.now() + 15 * 86400000);
    $('expiresAt').value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  } else if (plan === 'PRO') {
    $('maxStorageGb').value = '500'; $('maxDevices').value = '10'; $('expiresAt').value = '';
  } else {
    $('maxStorageGb').value = '10000'; $('maxDevices').value = '1000'; $('expiresAt').value = '';
  }
});

$('issue-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('issue-button');
  const issueMessage = $('issue-message');
  button.disabled = true;
  issueMessage.textContent = '';
  lastLicense = null;
  $('result-content').classList.add('hidden');
  $('result-title').textContent = 'Emitindo licença…';
  try {
    const form = new FormData(event.currentTarget);
    const result = await api('/api/issue', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
    lastLicense = result;
    $('license-key').value = result.key;
    $('result-customer').textContent = result.license.customer;
    $('result-plan').textContent = result.license.plan;
    $('result-title').textContent = 'Licença emitida';
    $('result-description').textContent = 'Copie a chave ou baixe o arquivo para enviar ao cliente.';
    $('result-content').classList.remove('hidden');
  } catch (error) {
    $('result-title').textContent = 'Não foi possível emitir';
    issueMessage.textContent = error.message;
  } finally { button.disabled = false; }
});

$('copy-key').addEventListener('click', async () => {
  if (!lastLicense) return;
  await navigator.clipboard.writeText(lastLicense.key);
  $('copy-key').textContent = 'Chave copiada';
  setTimeout(() => { $('copy-key').textContent = 'Copiar chave'; }, 1800);
});

$('download-key').addEventListener('click', () => {
  if (!lastLicense) return;
  const file = new Blob([JSON.stringify(lastLicense, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = `PACS-CHX-${lastLicense.license.licenseId}.chxlic`;
  link.click();
  URL.revokeObjectURL(url);
});

checkSession();
