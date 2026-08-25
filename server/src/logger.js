import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// In-memory ring buffer plus persistent daily log files.
// In production you'd also write to a log file or syslog.

const MAX_LOGS = 500;

export class Logger {
  constructor(logPath) {
    this.logs = [];
    this.logPath = logPath;
    if (logPath) mkdirSync(logPath, { recursive: true });
  }

  _add(level, message, source) {
    const entry = {
      id: `l${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      level,
      message,
      source: source ?? 'SYSTEM',
    };
    this.logs.unshift(entry);
    if (this.logs.length > MAX_LOGS) this.logs.pop();

    const prefix = level === 'error' ? '✗' : level === 'warning' ? '!' : level === 'success' ? '✓' : '·';
    console.log(`[${entry.timestamp}] ${prefix} [${source}] ${message}`);
    if (this.logPath) {
      const day = entry.timestamp.slice(0, 10);
      appendFileSync(join(this.logPath, `pacs-${day}.log`), `${entry.timestamp}\t${level.toUpperCase()}\t${source ?? 'SYSTEM'}\t${message}\n`, 'utf8');
    }
  }

  info(msg, source) { this._add('info', msg, source); }
  success(msg, source) { this._add('success', msg, source); }
  warning(msg, source) { this._add('warning', msg, source); }
  error(msg, source) { this._add('error', msg, source); }

  getLogs() {
    return this.logs;
  }

  clear() {
    this.logs = [];
  }
}
