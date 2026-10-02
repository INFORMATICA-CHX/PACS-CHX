const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const http = require('node:http');
const { autoUpdater } = require('electron-updater');

const SERVICE_NAME = 'PACS CHX Server';

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('no-sandbox');

let managerWindow;
let pacsProcess;
let serverStartedAt;
let serverLastError;
let updateCheckStarted = false;

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
  managerWindow.loadFile(join(distRoot, 'manager.html'));
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

function startServer() {
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

function stopServer() {
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
  if (!result.ok && !/already running|ja.*iniciado|iniciado/i.test(result.stdout + result.stderr)) {
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

app.whenReady().then(() => {
  const session = require('electron').session;
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  createWindow();
  ipcMain.handle('server:start', startServer);
  ipcMain.handle('server:stop', stopServer);
  ipcMain.handle('server:status', () => {
    if (pacsProcess) return {
      running: true,
      pid: pacsProcess.pid ?? null,
      startedAt: serverStartedAt ?? null,
      lastError: serverLastError ?? null,
    };
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
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = console;
    autoUpdater.on('update-available', (info) => {
      console.info(`[PACS CHX] Atualizacao ${info.version} encontrada; baixando em segundo plano.`);
    });
    autoUpdater.on('update-not-available', () => {
      console.info('[PACS CHX] PACS CHX esta atualizado.');
    });
    autoUpdater.on('error', (error) => {
      console.warn(`[PACS CHX] Nao foi possivel verificar/baixar atualizacao: ${error.message}`);
    });
    autoUpdater.on('update-downloaded', async (info) => {
      const result = await dialog.showMessageBox(managerWindow, {
        type: 'info',
        title: 'Atualizacao pronta',
        message: `A versao ${info.version} do PACS CHX foi baixada.`,
        detail: 'Reinicie o PACS agora para concluir a atualizacao. O servidor local sera reiniciado durante o processo.',
        buttons: ['Reiniciar agora', 'Depois'],
        defaultId: 0,
        cancelId: 1,
      });
      if (result.response === 0) autoUpdater.quitAndInstall();
    });
    setTimeout(() => {
      if (updateCheckStarted) return;
      updateCheckStarted = true;
      autoUpdater.checkForUpdates().catch((error) => {
        console.warn(`[PACS CHX] Verificacao de atualizacao indisponivel: ${error.message}`);
      });
    }, 5000);
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (!app.isPackaged) stopServer(); });
