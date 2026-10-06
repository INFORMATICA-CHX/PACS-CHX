// Configuration management — persists to config.json on disk.
// Survives restarts. The frontend reads/writes this via the REST API.

import { copyFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve, dirname } from 'node:path';

const serverDir = resolve(process.env.PACS_SERVER_ROOT || process.cwd());
const configDir = resolve(process.env.PACS_CONFIG_DIR || (process.env.APPDATA ? resolve(process.env.APPDATA, 'PACS CHX') : serverDir));

const DEFAULT_CONFIG = {
  aeTitle: 'PACSCHX',
  listenIp: '0.0.0.0',
  listenPort: 11112,
  apiPort: 4000,
  viewerUser: 'admin',
  storagePath: resolve(configDir, 'storage'),
  dbPath: resolve(configDir, 'pacs.db'),
  logPath: resolve(configDir, 'logs'),
  backup: { enabled: false, destination: '', intervalHours: 24 },
  dicom: { acceptUnknownSources: false },
  license: {
    revocationCheckIntervalHours: 0.25,
    revocationRepo: { owner: 'INFORMATICA-CHX', repo: 'PACS-LICENCAS', path: 'revocations.json', branch: 'main' },
  },
  session: { idleTimeoutMinutes: 120 },
  https: {
    enabled: true,
    port: 4443,
    certPath: resolve(serverDir, 'certs/pacs-chx.crt'),
    keyPath: resolve(serverDir, 'certs/pacs-chx.key'),
  },
  remoteDevices: [
    { id: 'rd1', kind: 'node', aeTitle: 'CT_SCANNER_01', ip: '192.168.10.20', port: 11112, description: 'CT Scanner 1', enabled: true },
  ],
};

function detectListenIp() {
  const interfaces = networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal && address.address.startsWith('192.168.')) return address.address;
    }
  }
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return '127.0.0.1';
}

const LEGACY_CONFIG_PATH = resolve(serverDir, 'config.json');
const CONFIG_PATH = resolve(configDir, 'config.json');

export function loadConfig() {
  mkdirSync(configDir, { recursive: true });
  if (!existsSync(CONFIG_PATH) && existsSync(LEGACY_CONFIG_PATH)) {
    if (process.env.PACS_CONFIG_DIR) {
      // A packaged configuration may contain paths from the build computer.
      // Only initialize paths on first installation; preserve existing settings.
      const initial = JSON.parse(readFileSync(LEGACY_CONFIG_PATH, 'utf-8').replace(/^\uFEFF/, ''));
      initial.dbPath = DEFAULT_CONFIG.dbPath;
      initial.storagePath = DEFAULT_CONFIG.storagePath;
      initial.logPath = DEFAULT_CONFIG.logPath;
      writeFileSync(CONFIG_PATH, JSON.stringify(initial, null, 2));
    } else {
      copyFileSync(LEGACY_CONFIG_PATH, CONFIG_PATH);
    }
  }
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  const raw = readFileSync(CONFIG_PATH, 'utf-8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(raw);
  if (parsed.license?.revocationRepo && Object.hasOwn(parsed.license.revocationRepo, 'token')) {
    delete parsed.license.revocationRepo.token;
    writeFileSync(CONFIG_PATH, JSON.stringify(parsed, null, 2));
  }
  const config = {
    ...DEFAULT_CONFIG, ...parsed,
    backup: { ...DEFAULT_CONFIG.backup, ...parsed.backup },
    dicom: { ...DEFAULT_CONFIG.dicom, ...parsed.dicom },
    license: { ...DEFAULT_CONFIG.license, ...parsed.license, revocationRepo: { ...DEFAULT_CONFIG.license.revocationRepo, ...parsed.license?.revocationRepo } },
    session: { ...DEFAULT_CONFIG.session, ...parsed.session },
    https: { ...DEFAULT_CONFIG.https, ...parsed.https },
  };
  if (process.env.PACS_CONFIG_DIR) {
    let corrected = false;
    if (!isLocalListenIp(config.listenIp)) { config.listenIp = DEFAULT_CONFIG.listenIp; corrected = true; }
    if (!existsSync(dirname(config.dbPath))) {
      throw new Error(`Pasta do banco configurado indisponivel: ${dirname(config.dbPath)}. Restaure o acesso ou confira a configuracao; o banco nao foi redirecionado.`);
    }
    if (config.https?.enabled && (!existsSync(config.https.certPath) || !existsSync(config.https.keyPath))) {
      config.https = { ...config.https, certPath: DEFAULT_CONFIG.https.certPath, keyPath: DEFAULT_CONFIG.https.keyPath };
      corrected = true;
    }
    // Processos externos (o SCP DICOM em Python) leem config.json direto do disco,
    // sem passar por essas correcoes em memoria — por isso precisam ser persistidas aqui.
    if (corrected) writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  }
  mkdirSync(config.storagePath, { recursive: true });
  mkdirSync(config.logPath, { recursive: true });
  mkdirSync(dirname(config.dbPath), { recursive: true });
  return config;
}

function isLocalListenIp(value) {
  const ip = String(value || '').trim();
  if (!ip || ip === '0.0.0.0' || ip === '127.0.0.1' || ip === 'localhost') return true;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && address.address === ip) return true;
    }
  }
  return false;
}

export function saveConfig(config) {
  mkdirSync(config.storagePath, { recursive: true });
  mkdirSync(config.logPath, { recursive: true });
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const { viewerPassword: _secret, ...safeConfig } = config;
  if (safeConfig.license?.revocationRepo) {
    safeConfig.license = { ...safeConfig.license, revocationRepo: { ...safeConfig.license.revocationRepo } };
    delete safeConfig.license.revocationRepo.token;
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(safeConfig, null, 2));
  return safeConfig;
}
