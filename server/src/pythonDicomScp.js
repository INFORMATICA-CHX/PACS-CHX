import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DicomScp } from './dicomScp.js';

export class PythonDicomScp extends DicomScp {
  constructor(config, db, logger) {
    super(config, db, logger);
    this.process = null;
    this.running = false;
    this.startedAt = null;
    this.poller = null;
    this.inboxPath = resolve(process.env.PACS_CONFIG_DIR || process.cwd(), 'dicom-inbox');
  }

  start() {
    if (this.running) return Promise.resolve();
    mkdirSync(this.inboxPath, { recursive: true });
    const serverDir = resolve(process.env.PACS_SERVER_ROOT || process.cwd());
    const scriptPath = resolve(serverDir, 'python', 'dicom_scp.py');
    const configPath = resolve(process.env.PACS_CONFIG_DIR || serverDir, 'config.json');
    const pythonExecutable = process.env.PACS_PYTHON_PATH || 'python';

    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(pythonExecutable, [scriptPath, '--config', configPath, '--inbox', this.inboxPath], {
        cwd: serverDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.process = child;
      let settled = false;

      child.stdout.on('data', (data) => {
        for (const line of String(data).split(/\r?\n/).filter(Boolean)) this.handlePythonLog(line);
        if (!settled && this.running) {
          settled = true;
          resolvePromise();
        }
      });
      child.stderr.on('data', (data) => this.logger.error(String(data).trim(), 'PYDICOM'));
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        this.process = null;
        this.logger.warning(`Python indisponivel (${error.message}); usando SCP JavaScript integrado.`, 'PYDICOM');
        super.start().then(resolvePromise, rejectPromise);
      });
      child.on('exit', (code) => {
        this.running = false;
        this.process = null;
        if (this.poller) clearInterval(this.poller);
        this.poller = null;
        if (!settled) {
          settled = true;
          this.logger.warning(`Python DICOM SCP encerrou com codigo ${code ?? 'desconhecido'}; usando SCP JavaScript integrado.`, 'PYDICOM');
          super.start().then(resolvePromise, rejectPromise);
        } else if (code && code !== 0) this.logger.error(`Python DICOM SCP encerrou com codigo ${code}`, 'PYDICOM');
      });

      setTimeout(() => {
        if (settled) return;
        if (child.exitCode != null) return;
        this.running = true;
        this.startedAt = new Date().toISOString();
        this.startInboxPoller();
        settled = true;
        resolvePromise();
      }, 1200);
    });
  }

  stop() {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    if (this.process) {
      const child = this.process;
      this.process = null;
      return new Promise((resolvePromise) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          this.running = false;
          this.logger.warning('Python DICOM SCP stopped', 'PYDICOM');
          resolvePromise();
        };
        child.once('exit', finish);
        child.kill();
        setTimeout(finish, 2500);
      });
    }
    this.running = false;
    this.logger.warning('Python DICOM SCP stopped', 'PYDICOM');
    return Promise.resolve();
  }

  handlePythonLog(line) {
    try {
      const entry = JSON.parse(line);
      const level = ['info', 'warning', 'error', 'success'].includes(entry.level) ? entry.level : 'info';
      this.logger[level](entry.message, 'PYDICOM');
      if (String(entry.message).includes('listening')) {
        this.running = true;
        this.startedAt = this.startedAt ?? new Date().toISOString();
        this.startInboxPoller();
      }
    } catch {
      this.logger.info(line, 'PYDICOM');
    }
  }

  startInboxPoller() {
    if (this.poller) return;
    this.poller = setInterval(() => this.importInbox(), 500);
    this.poller.unref();
  }

  importInbox() {
    if (!existsSync(this.inboxPath)) return;
    for (const entry of readdirSync(this.inboxPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.dcm')) continue;
      const filePath = join(this.inboxPath, entry.name);
      try {
        this.importFile(filePath);
        rmSync(filePath, { force: true });
      } catch (error) {
        this.logger.error(`Falha ao indexar DICOM recebido: ${error.message}`, 'PYDICOM');
      }
    }
  }

  async testEcho(device) {
    return new Promise((resolvePromise) => {
      const host = String(device.ip || '').trim();
      if (!host) {
        resolvePromise({ success: false, message: 'IP vazio' });
        return;
      }
      const isWindows = process.platform === 'win32';
      const args = isWindows ? ['-n', '1', '-w', '3000', host] : ['-c', '1', '-W', '3', host];
      execFile('ping', args, { windowsHide: true, timeout: 5000 }, (error, stdout = '') => {
        const output = String(stdout);
        const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const hasReply = isWindows
          ? new RegExp(`Resposta de ${escapedHost}:`, 'i').test(output) || new RegExp(`Reply from ${escapedHost}:`, 'i').test(output)
          : new RegExp(`bytes from ${escapedHost}`, 'i').test(output);
        const unreachable = /inacessivel|inaccessible|unreachable|esgotado|timed out|100% loss|100% perdidos/i.test(output);
        resolvePromise({ success: !error && hasReply && !unreachable, message: !error && hasReply && !unreachable ? 'IP respondeu ao ping' : 'IP sem resposta ao ping' });
      });
    });
  }

  async sendStore(device, files) {
    const fileList = (files ?? []).filter(Boolean);
    if (!fileList.length) return { success: false, sent: 0, failed: 0, message: 'Nenhum arquivo DICOM encontrado para envio.' };
    const serverDir = resolve(process.env.PACS_SERVER_ROOT || process.cwd());
    const scriptPath = resolve(serverDir, 'python', 'dicom_send.py');
    const pythonExecutable = process.env.PACS_PYTHON_PATH || 'python';
    const args = [
      scriptPath,
      '--calling-ae', String(device.callingAeTitle || this.config.aeTitle || 'PACSCHX'),
      '--called-ae', String(device.aeTitle || ''),
      '--host', String(device.ip || ''),
      '--port', String(device.port || ''),
      ...fileList,
    ];

    return new Promise((resolvePromise) => {
      const child = spawn(pythonExecutable, args, { cwd: serverDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => { stdout += String(data); });
      child.stderr.on('data', (data) => { stderr += String(data); });
      child.on('error', (error) => resolvePromise({ success: false, sent: 0, failed: fileList.length, message: error.message }));
      child.on('exit', (code) => {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
        try {
          const result = JSON.parse(line || '{}');
          resolvePromise({
            success: Boolean(result.ok),
            sent: Number(result.sent) || 0,
            failed: Number(result.failed) || 0,
            failures: result.failures ?? [],
            message: result.ok ? `Enviado ${result.sent} arquivo(s)` : (result.error || stderr.trim() || `Falha no envio DICOM (codigo ${code ?? 'desconhecido'})`),
          });
        } catch {
          resolvePromise({ success: false, sent: 0, failed: fileList.length, message: stderr.trim() || stdout.trim() || `Falha no envio DICOM (codigo ${code ?? 'desconhecido'})` });
        }
      });
    });
  }

  async sendPrint(device, files, options = {}) {
    const fileList = (files ?? []).filter(Boolean);
    if (!fileList.length) return { success: false, sent: 0, failed: 0, message: 'Nenhum arquivo DICOM encontrado para impressao.' };
    const serverDir = resolve(process.env.PACS_SERVER_ROOT || process.cwd());
    const scriptPath = resolve(serverDir, 'python', 'dicom_print.py');
    const pythonExecutable = process.env.PACS_PYTHON_PATH || 'python';
    const args = [
      scriptPath,
      '--calling-ae', String(device.callingAeTitle || this.config.aeTitle || 'PACSCHX'),
      '--called-ae', String(device.aeTitle || ''),
      '--host', String(device.ip || ''),
      '--port', String(device.port || ''),
      '--copies', String(Math.max(1, Number(options.copies) || 1)),
      '--layout', String(options.layout || '1x1'),
      '--orientation', String(options.orientation || 'portrait'),
      '--film-size', String(options.filmSize || '14INX17IN'),
      ...fileList,
    ];

    return new Promise((resolvePromise) => {
      const child = spawn(pythonExecutable, args, { cwd: serverDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => { stdout += String(data); });
      child.stderr.on('data', (data) => { stderr += String(data); });
      child.on('error', (error) => resolvePromise({ success: false, sent: 0, failed: fileList.length, message: error.message }));
      child.on('exit', (code) => {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
        try {
          const result = JSON.parse(line || '{}');
          resolvePromise({
            success: Boolean(result.ok),
            sent: Number(result.sent) || 0,
            failed: result.ok ? 0 : fileList.length,
            printed: Number(result.printed) || 0,
            message: result.ok ? (result.message || 'Filme enviado para impressora DICOM.') : (result.error || stderr.trim() || `Falha na impressao DICOM (codigo ${code ?? 'desconhecido'})`),
          });
        } catch {
          resolvePromise({ success: false, sent: 0, failed: fileList.length, message: stderr.trim() || stdout.trim() || `Falha na impressao DICOM (codigo ${code ?? 'desconhecido'})` });
        }
      });
    });
  }
}
