const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const { generateKeyPairSync, sign, randomBytes } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
const { adminStatus, configureKeyProtection, deleteLicense, listLicenses, recordLicense, setupAdminPassword } = require('./licenseStore.cjs');

function keyPaths() {
  const keysDir = join(app.getPath('userData'), 'issuer-keys');
  return { keysDir, privatePath: join(keysDir, 'private.pem'), publicPath: join(keysDir, 'public.pem') };
}
function protectPrivateKey(privateKey) {
  return safeStorage.encryptString(String(privateKey)).toString('base64');
}
function readPrivateKey(privatePath) {
  return safeStorage.decryptString(Buffer.from(readFileSync(privatePath, 'utf8'), 'base64'));
}
function ensureKeys() {
  const { keysDir, privatePath, publicPath } = keyPaths();
  mkdirSync(keysDir, { recursive: true });
  const legacyPrivate = join(__dirname, 'keys', 'private.pem');
  const legacyPublic = join(__dirname, 'keys', 'public.pem');
  if (!existsSync(privatePath) && existsSync(legacyPrivate)) {
    copyFileSync(legacyPrivate, privatePath);
    if (existsSync(legacyPublic)) copyFileSync(legacyPublic, publicPath);
    unlinkSync(legacyPrivate);
  }
  if (!existsSync(privatePath) || !existsSync(publicPath)) {
    const installedPublicKey = join(__dirname, '..', 'server', 'license-public.pem');
    if (!existsSync(privatePath) && existsSync(installedPublicKey)) {
      throw new Error('Chave privada do emissor ausente. Importe a chave protegida deste emissor; uma nova chave não será criada para evitar invalidar licenças existentes.');
    }
    const pair = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    writeFileSync(privatePath, protectPrivateKey(pair.privateKey), { mode: 0o600 });
    writeFileSync(publicPath, pair.publicKey);
  }
  const storedPrivateKey = readFileSync(privatePath, 'utf8');
  if (storedPrivateKey.includes('-----BEGIN PRIVATE KEY-----')) {
    writeFileSync(privatePath, protectPrivateKey(storedPrivateKey), { mode: 0o600 });
    console.warn('[License Manager] Chave privada migrada para o formato protegido pelo safeStorage.');
  }
  copyFileSync(publicPath, join(__dirname, '..', 'server', 'license-public.pem'));
}
function issue(claims) {
  ensureKeys();
  const { privatePath } = keyPaths();
  const machineCode = String(claims.machineId || '').trim();
  const plan = String(claims.plan || 'PRO').trim().toUpperCase();
  const planDefaults = {
    TRIAL: {
      expiresAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      limits: { maxStorageGb: 100, maxDevices: 5, maxUsers: 3, maxStudies: 1000 },
      features: ['dicom-store', 'web-viewer', 'local-import', 'backup'],
    },
    PRO: {
      expiresAt: null,
      limits: { maxStorageGb: 500, maxDevices: 10, maxUsers: null, maxStudies: null },
      features: ['dicom-store', 'web-viewer', 'local-import', 'backup'],
    },
    FULL: {
      expiresAt: null,
      limits: { maxStorageGb: 10000, maxDevices: 1000, maxUsers: null, maxStudies: null },
      features: ['dicom-store', 'web-viewer', 'local-import', 'backup', 'worklist'],
    },
  };
  const preset = planDefaults[plan] || planDefaults.PRO;
  const customExpiresAt = normalizeExpiration(claims.expiresAt);
  let machineFingerprint;
  if (machineCode.startsWith('CHX3.')) {
    try {
      const sources = JSON.parse(Buffer.from(machineCode.slice(5), 'base64url').toString('utf8'));
      const validSources = Object.entries(sources).filter(([name, value]) => ['machine', 'disk', 'bios'].includes(name) && /^[A-F0-9]{64}$/.test(String(value)));
      if (validSources.length < 2) throw new Error();
      machineFingerprint = Object.fromEntries(validSources);
    } catch { throw new Error('Informe um codigo multifonte valido do servidor do cliente.'); }
  }
  const license = {
    version: machineFingerprint ? 3 : 2,
    licenseId: randomBytes(12).toString('hex'),
    customer: String(claims.customer || '').trim(),
    machineId: machineFingerprint ? machineCode : machineCode.toUpperCase(),
    ...(machineFingerprint ? { machineFingerprint } : {}),
    plan,
    issuedAt: new Date().toISOString(),
    expiresAt: customExpiresAt === undefined ? preset.expiresAt : customExpiresAt,
    limits: {
      maxStorageGb: Number(claims.maxStorageGb) || preset.limits.maxStorageGb,
      maxDevices: Number(claims.maxDevices) || preset.limits.maxDevices,
      maxUsers: preset.limits.maxUsers,
      maxStudies: preset.limits.maxStudies,
    },
    features: preset.features,
  };
  if (!license.customer) throw new Error('Informe o titular.');
  if (!machineFingerprint && !/^(?:[A-F0-9]{8}-){7}[A-F0-9]{8}$/.test(license.machineId)) throw new Error('Informe o codigo completo do servidor do cliente.');
  for (const value of Object.values(license.limits)) if (value !== null && (!Number.isFinite(value) || value < 1)) throw new Error('Todos os limites devem ser maiores que zero.');
  const payload = Buffer.from(JSON.stringify(license)).toString('base64url');
  const signature = sign(null, Buffer.from(payload), readPrivateKey(privatePath)).toString('base64url');
  return recordLicense({ license, key: `CHX1.${payload}.${signature}` });
}

function normalizeExpiration(value) {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const date = new Date(dateOnly ? `${text}T12:00:00` : text);
  if (Number.isNaN(date.getTime())) throw new Error('Informe uma validade valida.');
  return dateOnly ? text : date.toISOString();
}

app.whenReady().then(() => {
  configureKeyProtection(
    (value) => safeStorage.encryptString(String(value)).toString('base64'),
    (value) => safeStorage.decryptString(Buffer.from(String(value), 'base64')),
  );
  ensureKeys();
  listLicenses();
  const issueFiveMinuteIndex = process.argv.indexOf('--issue-5min');
  if (issueFiveMinuteIndex >= 0) {
    const machineId = process.argv[issueFiveMinuteIndex + 1];
    const customer = process.argv[issueFiveMinuteIndex + 2] || 'Teste 5 minutos';
    const result = issue({
      customer,
      machineId,
      plan: 'TRIAL',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      maxStorageGb: 100,
      maxDevices: 5,
      maxUsers: 3,
      maxStudies: 1000,
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = join(__dirname, `chx-teste-5min-${stamp}.chxlic`);
    writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(outputPath);
    console.log(`Expira em: ${result.license.expiresAt}`);
    app.quit();
    return;
  }
  if (process.argv.includes('--security-migrate-only')) {
    app.quit();
    return;
  }
  const win = new BrowserWindow({
    width: 1080,
    height: 800,
    minWidth: 820,
    minHeight: 660,
    title: 'PACS CHX License Authority',
    icon: join(__dirname, 'assets', 'pacs-chx-logo.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: join(__dirname, 'preload.cjs'),
    },
  });
  win.loadFile(join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  ipcMain.handle('license:issue', (_event, claims) => issue(claims));
  ipcMain.handle('license:history', () => listLicenses());
  ipcMain.handle('license:admin-status', () => adminStatus());
  ipcMain.handle('license:admin-setup', (_event, password) => setupAdminPassword(password));
  ipcMain.handle('license:delete', (_event, request) => deleteLicense(request?.licenseId, request?.password));
  ipcMain.handle('license:save', async (_event, data) => {
    const result = await dialog.showSaveDialog(win, { defaultPath: `${data.license.customer.replace(/[^a-z0-9]+/gi, '-')}.chxlic`, filters: [{ name: 'PACS CHX License', extensions: ['chxlic'] }] });
    if (result.canceled) return null;
    writeFileSync(result.filePath, JSON.stringify(data, null, 2));
    return result.filePath;
  });
});
app.on('window-all-closed', () => app.quit());
