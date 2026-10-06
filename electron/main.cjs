const { app, BrowserWindow, shell, ipcMain, dialog, protocol, net } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join, resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const http = require('node:http');
const { autoUpdater } = require('electron-updater');

protocol.registerSchemesAsPrivileged([{ scheme: 'pacs', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

const SERVICE_NAME = 'PACS CHX Server';

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('no-sandbox');

let managerWindow;
let updateWindow;
let pacsProcess;
let serverStartedAt;
let serverLastError;
let updateCheckStarted = false;
let updateResolved = false;

function showUpdateWindow(status = 'Verificando atualizações…', progress = null) {
  if (!updateWindow || updateWindow.isDestroyed()) {
    updateWindow = new BrowserWindow({
      width: 440,
      height: 330,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'PACS CHX — Atualização',
      backgroundColor: '#07111f',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    updateWindow.on('closed', () => { updateWindow = null; });
  }

  const safeStatus = String(status).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const percent = Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : null;
  const progressMarkup = percent === null
    ? '<div class="spinner" aria-label="Em andamento"></div>'
    : `<div class="track"><div class="fill" style="width:${percent}%"></div></div><small>${percent}%</small>`;
  const logoPath = join(app.isPackaged ? process.resourcesPath : join(__dirname, '..'), 'app.asar.unpacked', 'dist', 'brand', 'pacs-chx-logo.png').replace(/\\/g, '/');
  const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PACS CHX</title><style>
    *{box-sizing:border-box}body{margin:0;height:100vh;display:grid;place-items:center;background:radial-gradient(ellipse at 50% 0%,#123456 0%,#07111f 68%);color:#e8f2ff;font:14px 'Segoe UI',sans-serif}.card{text-align:center;width:100%;padding:34px}.logo{width:68px;height:68px;object-fit:contain;margin-bottom:15px}.brand{font-size:22px;font-weight:700;letter-spacing:.08em}.label{color:#70d9e8;font-size:11px;letter-spacing:.2em;text-transform:uppercase;margin-top:6px}.status{margin:27px 0 17px;color:#bdcce0}.track{height:6px;border-radius:9px;background:#1d3044;overflow:hidden}.fill{height:100%;background:linear-gradient(90deg,#16a6c1,#58e2d5);transition:width .2s}.spinner{width:25px;height:25px;border:3px solid #294257;border-top-color:#57d9df;border-radius:50%;margin:auto;animation:spin .8s linear infinite}small{display:block;text-align:right;color:#91a7bc;margin-top:7px}@keyframes spin{to{transform:rotate(360deg)}}</style><body><main class="card"><img class="logo" src="file://${logoPath}" onerror="this.style.display='none'"><div class="brand">PACS CHX</div><div class="label">Atualização do sistema</div><div class="status">${safeStatus}</div>${progressMarkup}</main></body></html>`;
  updateWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  updateWindow.center();
}

function closeUpdateWindow() {
  if (updateWindow && !updateWindow.isDestroyed()) updateWindow.close();
  updateWindow = null;
}

function openManagerWindow() {
  if (updateResolved) return;
  updateResolved = true;
  closeUpdateWindow();
  createWindow();
}

function createWindow() {
  const appRoot = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : join(__dirname, '..');
  const distRoot = join(appRoot, 'dist');
  const iconPath = join(distRoot, 'brand', 'pacs-chx-logo.png');
  managerWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    title: 'PACS CHX - DICOM Server Manager',
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });
  managerWindow.loadURL('pacs://app/manager.html');
  managerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  managerWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  managerWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.error(`[DEBUG did-fail-load] code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
  });
  managerWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[DEBUG render-process-gone] ${JSON.stringify(details)}`);
  });
  managerWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[DEBUG renderer console] level=${level} ${sourceId}:${line} ${message}`);
  });
  managerWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error(`[DEBUG preload-error] ${preloadPath} ${error && error.message}`);
  });
}

function resolveServerRoot() {
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'server')
    : join(__dirname, '..', 'server');
}

// Reads apiPort from server/config.json so the probe follows a port change.
function apiPort() {
  try {
    const raw = readFileSync(join(resolveServerRoot(), 'config.json'), 'utf8').replace(/^﻿/, '');
    const port = Number(JSON.parse(raw).apiPort);
    return port >= 1 && port <= 65535 ? port : 4000;
  } catch {
    return 4000;
  }
}

// True when *something* is already answering the local REST API — i.e. the server
// is up, whether this manager spawned it or it was started separately
// (INICIAR-WEB-SERVIDOR.bat, a Windows service, another manager window...).
function probeApi() {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port: apiPort(), path: '/api/config', timeout: 1500 }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

async function startServer() {
  // Never spawn a second server on top of a running one — the child would just
  // die on EADDRINUSE and leave the UI showing "parado".
  if (await probeApi()) {
    if (!serverStartedAt) serverStartedAt = new Date().toISOString();
    return { running: true, pid: pacsProcess?.pid ?? null, startedAt: serverStartedAt, lastError: null };
  }
  if (app.isPackaged) return startService();
  return startChildServer();
}

function startChildServer() {
  if (pacsProcess) return { running: true, pid: pacsProcess.pid, startedAt: serverStartedAt, lastError: serverLastError };
  const root = join(__dirname, '..');
  const serverRoot = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked', 'server') : join(root, 'server');
  const serverEntry = join(serverRoot, 'build', 'server-loader.cjs');
  const bundledNode = join(process.resourcesPath, 'node', 'node.exe');
  const serverExecutable = process.env.PACS_NODE_PATH || (app.isPackaged && existsSync(bundledNode) ? bundledNode : 'node');
  const bundledPython = join(process.resourcesPath, 'python', 'python.exe');
  const configDir = process.env.ProgramData ? join(process.env.ProgramData, 'PACS CHX') : join(app.getPath('appData'), 'PACS CHX');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '', PACS_SERVER_ROOT: serverRoot, PACS_CONFIG_DIR: configDir };
  if (!env.PACS_PYTHON_PATH && app.isPackaged && existsSync(bundledPython)) env.PACS_PYTHON_PATH = bundledPython;
  pacsProcess = spawn(serverExecutable, [serverEntry], {
    cwd: serverRoot,
    windowsHide: true,
    stdio: 'pipe',
    env,
  });
  serverStartedAt = new Date().toISOString();
  serverLastError = undefined;
  pacsProcess.on('exit', (code) => {
    if (code && code !== 0) serverLastError = `Processo encerrado com codigo ${code}`;
    pacsProcess = undefined;
  });
  pacsProcess.stderr.on('data', (data) => {
    serverLastError = String(data).trim();
    console.error(`[PACS CHX] ${data}`);
  });
  return { running: true, pid: pacsProcess.pid, startedAt: serverStartedAt, lastError: null };
}

async function stopServer() {
  // If this manager didn't spawn the server, it isn't ours to kill: it came from
  // INICIAR-WEB-SERVIDOR.bat or a service. Say so instead of pretending it stopped.
  if (!pacsProcess && !app.isPackaged && await probeApi()) {
    return {
      running: true,
      pid: null,
      startedAt: serverStartedAt ?? null,
      lastError: 'O servidor foi iniciado fora do gerenciador. Feche a janela "PACS CHX Server" para encerra-lo.',
    };
  }
  if (app.isPackaged) return stopService();
  return stopChildServer();
}

function stopChildServer() {
  if (pacsProcess) pacsProcess.kill();
  pacsProcess = undefined;
  serverStartedAt = undefined;
  return { running: false, pid: null, startedAt: null, lastError: serverLastError ?? null };
}

function runSc(args) {
  return new Promise((resolve) => {
    execFile('sc.exe', args, { windowsHide: true, timeout: 10000 }, (error, stdout = '', stderr = '') => {
      resolve({ ok: !error, error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function queryService() {
  const result = await runSc(['queryex', SERVICE_NAME]);
  if (!result.ok) return { running: false, pid: null, startedAt: null, lastError: serviceError(result) };
  const stateLine = result.stdout.match(/STATE\s*:\s*\d+\s+(\w+)/i);
  const pidLine = result.stdout.match(/PID\s*:\s*(\d+)/i);
  const running = stateLine?.[1]?.toUpperCase() === 'RUNNING';
  return {
    running,
    pid: running ? Number(pidLine?.[1] || 0) || null : null,
    startedAt: running ? serverStartedAt : null,
    lastError: null,
  };
}

async function startService() {
  if (pacsProcess) return { running: true, pid: pacsProcess.pid, startedAt: serverStartedAt, lastError: serverLastError };
  const current = await queryService();
  if (current.running) return current;
  if (/1060|does not exist|nao.*existe|não.*existe/i.test(current.lastError || '')) return startChildServer();
  const result = await runSc(['start', SERVICE_NAME]);
  if (!result.ok && !/1056|already running|ja.*iniciado|iniciado/i.test(result.stdout + result.stderr)) {
    return { running: false, pid: null, startedAt: null, lastError: serviceError(result) };
  }
  serverStartedAt = new Date().toISOString();
  return queryService();
}

async function stopService() {
  if (pacsProcess) return stopChildServer();
  const result = await runSc(['stop', SERVICE_NAME]);
  if (!result.ok && !/not been started|nao.*iniciado|1062/i.test(result.stdout + result.stderr)) {
    const status = await queryService();
    return { ...status, lastError: serviceError(result) };
  }
  serverStartedAt = undefined;
  return { running: false, pid: null, startedAt: null, lastError: null };
}

function serviceError(result) {
  return (result.stderr || result.stdout || result.error?.message || 'Servico PACS CHX indisponivel.').trim();
}

app.whenReady().then(async () => {
  const appRoot = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : join(__dirname, '..');
  const distRoot = resolve(appRoot, 'dist');
  await protocol.handle('pacs', (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
    let requestedPath;
    try { requestedPath = decodeURIComponent(url.pathname); }
    catch { return new Response('Bad path', { status: 400 }); }
    const filePath = resolve(distRoot, `.${requestedPath}`);
    if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${sep}`)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString()).then((response) => {
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('X-Frame-Options', 'DENY');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    });
  });
  const session = require('electron').session;
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ipcMain.handle('server:start', startServer);
  ipcMain.handle('server:stop', stopServer);
  ipcMain.handle('server:status', async () => {
    if (pacsProcess) return {
      running: true,
      pid: pacsProcess.pid ?? null,
      startedAt: serverStartedAt ?? null,
      lastError: serverLastError ?? null,
    };
    // Server started outside this manager still counts as running.
    if (await probeApi()) {
      if (!serverStartedAt) serverStartedAt = new Date().toISOString();
      return { running: true, pid: null, startedAt: serverStartedAt, lastError: null };
    }
    return app.isPackaged ? queryService() : {
      running: false,
      pid: null,
      startedAt: null,
      lastError: serverLastError ?? null,
    };
  });
  ipcMain.handle('viewer:open', () => {
    shell.openExternal('https://127.0.0.1:4443/viewer');
    return { opened: true };
  });
  ipcMain.handle('dialog:open-folder', async () => {
    const result = await dialog.showOpenDialog(managerWindow, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  if (!app.isPackaged) startServer();
  if (app.isPackaged && process.windowsStore !== true) {
    showUpdateWindow();
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = console;
    autoUpdater.on('update-available', (info) => {
      console.info(`[PACS CHX] Atualizacao ${info.version} encontrada; baixando em segundo plano.`);
      showUpdateWindow(`Baixando a versão ${info.version}…`);
    });
    autoUpdater.on('update-not-available', () => {
      console.info('[PACS CHX] PACS CHX esta atualizado.');
      showUpdateWindow('PACS CHX está atualizado. Iniciando…');
      setTimeout(openManagerWindow, 700);
    });
    autoUpdater.on('download-progress', (progress) => {
      showUpdateWindow('Baixando atualização…', progress.percent);
    });
    autoUpdater.on('error', (error) => {
      console.warn(`[PACS CHX] Nao foi possivel verificar/baixar atualizacao: ${error.message}`);
      showUpdateWindow('Não foi possível verificar agora. Iniciando o PACS…');
      setTimeout(openManagerWindow, 1200);
    });
    autoUpdater.on('update-downloaded', async (info) => {
      showUpdateWindow(`Versão ${info.version} baixada.`, 100);
      const result = await dialog.showMessageBox(updateWindow, {
        type: 'info',
        title: 'Atualizacao pronta',
        message: `A versao ${info.version} do PACS CHX foi baixada.`,
        detail: 'Reinicie o PACS agora para concluir a atualizacao. O servidor local sera reiniciado durante o processo.',
        buttons: ['Reiniciar agora', 'Depois'],
        defaultId: 0,
        cancelId: 1,
      });
      if (result.response === 0) autoUpdater.quitAndInstall();
      else openManagerWindow();
    });
    updateCheckStarted = true;
    autoUpdater.checkForUpdates().catch((error) => {
      console.warn(`[PACS CHX] Verificacao de atualizacao indisponivel: ${error.message}`);
      showUpdateWindow('Não foi possível verificar agora. Iniciando o PACS…');
      setTimeout(openManagerWindow, 1200);
    });
  } else {
    createWindow();
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && updateResolved) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (!app.isPackaged) stopServer(); });
