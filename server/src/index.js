// Main entry point for the PACS CHX DICOM server.
// Starts the SCP (TCP DICOM listener) and the REST API (Express).
//
// Usage:  node src/index.js
//
// Architecture:
//   - DicomScp:   TCP server implementing C-STORE SCP (receives .dcm files)
//   - Express API: REST endpoints consumed by the React frontend
//   - SQLite:      indexes DICOM metadata for fast worklist queries
//   - config.json: persisted network/storage settings
//
// FUTURE EXTENSION POINTS:
//   - C-FIND SCP:  accept queries from other PACS clients
//   - C-MOVE SCU:  retrieve studies from remote PACS servers
//   - Cloud backup: push received files to S3/GCS after local storage

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig, saveConfig } from './config.js';
import { initDb } from './database.js';
import { PythonDicomScp } from './pythonDicomScp.js';
import { Logger } from './logger.js';
import { createApiRouter } from './api.js';
import { initializeSecurity } from './securityStore.js';
import { createEncryptedBackup } from './backup.js';
import { licenseStatus, startRevocationChecks, stopRevocationChecks } from './license.js';

const serverDir = resolve(process.env.PACS_SERVER_ROOT || process.cwd());

const config = loadConfig();
const logger = new Logger(config.logPath);
const db = initDb(config.dbPath);
try {
  const clearedPrintJobs = db.prepare('DELETE FROM print_jobs').run().changes;
  if (clearedPrintJobs) logger.info(`Fila de impressao limpa no boot: ${clearedPrintJobs} job(s) removido(s)`, 'PRINT');
} catch (error) {
  logger.warning(`Fila de impressao nao foi limpa no boot: ${error.message}`, 'PRINT');
}
initializeSecurity(db, config);
const bootLicense = licenseStatus();
if (!bootLicense.active) logger.warning(`Licenca inativa no boot: ${bootLicense.error}`, 'SECURITY');
startRevocationChecks({ config, db, logger });
if (config.viewerPassword) { delete config.viewerPassword; saveConfig(config); }

logger.info('Starting PACS CHX Server...', 'SYSTEM');
logger.info(`Config: AE=${config.aeTitle}, listen=${config.listenIp}:${config.listenPort}`, 'CONFIG');
logger.info(`Storage: ${config.storagePath}`, 'CONFIG');
logger.info(`Database: ${config.dbPath}`, 'CONFIG');
logger.info(`Logs: ${config.logPath}`, 'CONFIG');

// Start the DICOM SCP
const scp = new PythonDicomScp(config, db, logger);
scp.start().catch((error) => {
  logger.error(`DICOM nao iniciou em ${config.listenIp}:${config.listenPort}: ${error.message}`, 'SCP');
});

// Start the REST API
const app = express();
const allowedOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/i;
app.disable('x-powered-by');
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigin.test(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by PACS CHX'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Service-Token', 'X-File-Name'],
  maxAge: 600,
}));
app.use(compression());
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (_req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if (_req.path.startsWith('/api/instances/') && (_req.path.endsWith('/pixels') || _req.path.endsWith('/file'))) res.setHeader('Cache-Control', 'private, max-age=3600');
  else res.setHeader('Cache-Control', _req.path.startsWith('/api/') ? 'no-store' : 'no-cache');
  next();
});
app.use(express.json({ limit: '2mb' }));

// Serve the built frontend (run `npm run build` in the project root first)
const distPath = resolve(serverDir, '../dist');
app.use(express.static(distPath));

app.use(createApiRouter(scp, db, config, logger, () => loadConfig(), saveConfig));

// SPA fallback — serve index.html for non-API routes
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(resolve(distPath, 'index.html'));
});

const API_PORT = config.apiPort ?? 4000;
const httpHost = config.https?.enabled ? '127.0.0.1' : '0.0.0.0';

if (!config.https?.enabled) {
  logger.warning('SECURITY: HTTPS DESATIVADO. Credenciais e dados trafegam sem criptografia; nao use esta instalacao em rede.', 'SECURITY');
}

if (config.https?.enabled) {
  try {
    const tlsServer = createHttpsServer({ cert: readFileSync(config.https.certPath), key: readFileSync(config.https.keyPath), minVersion: 'TLSv1.2' }, app);
    tlsServer.listen(Number(config.https.port) || 4443, '0.0.0.0', () => logger.success(`HTTPS ativo na porta ${config.https.port || 4443}`, 'SECURITY'));
  } catch (error) {
    logger.error(`HTTPS nao iniciado: ${error.message}. A API HTTP permanecera restrita ao loopback.`, 'SECURITY');
  }
}

app.listen(API_PORT, httpHost, () => {
  logger.success(`REST API HTTP local em http://${httpHost}:${API_PORT}`, 'REST');
  if (config.https?.enabled) logger.info('HTTP puro restrito ao loopback; acesso pela rede exige HTTPS.', 'SECURITY');
  logger.info(`Frontend served from ${distPath}`, 'REST');
});

let backupTimer = null;
if (config.backup?.enabled && config.backup.destination) {
  const interval = Math.max(1, Number(config.backup.intervalHours) || 24) * 60 * 60 * 1000;
  backupTimer = setInterval(() => {
    try {
      const result = createEncryptedBackup({ db, config, destination: config.backup.destination, keyPath: resolve(serverDir, 'backup.key') });
      logger.success(`Backup automatico verificado: ${result.root}`, 'BACKUP');
    } catch (error) { logger.error(`Backup automatico falhou: ${error.message}`, 'BACKUP'); }
  }, interval);
  backupTimer.unref();
  logger.info(`Backup automatico agendado a cada ${interval / 3600000} hora(s)`, 'BACKUP');
}

// Graceful shutdown
process.on('SIGINT', () => {
  stopRevocationChecks();
  if (backupTimer) clearInterval(backupTimer);
  logger.warning('Shutting down...', 'SYSTEM');
  scp.stop();
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopRevocationChecks();
  scp.stop();
  db.close();
  process.exit(0);
});
