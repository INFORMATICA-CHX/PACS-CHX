import { useMemo } from 'react';
import {
  Server, Activity, HardDrive, Database, Radio, AlertTriangle,
  CheckCircle2, Info, XCircle, Play, Square, Trash2, Download,
} from 'lucide-react';
import type { LogLevel } from '@/types';
import type { PacsStore } from '@/lib/usePacsStore';

interface StatusProps {
  store: PacsStore;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatUptime(startedAt: string | null): string {
  if (!startedAt) return '—';
  const ms = Date.now() - new Date(startedAt).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${h}h ${m}m ${s}s`;
}

const levelConfig: Record<LogLevel, { icon: typeof Info; color: string; bg: string }> = {
  info: { icon: Info, color: 'text-slate-500', bg: 'bg-slate-100' },
  success: { icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-50' },
  warning: { icon: AlertTriangle, color: 'text-amber-600', bg: 'bg-amber-50' },
  error: { icon: XCircle, color: 'text-red-500', bg: 'bg-red-50' },
};

export function Status({ store }: StatusProps) {
  const { status, logs, config, toggleServer, clearLogs, addLog, recordReceivedStudy } = store;

  const stats = useMemo(
    () => [
      { label: 'Status', value: status.running ? 'Online' : 'Offline', icon: Server, accent: status.running ? 'emerald' : 'red' },
      { label: 'Uptime', value: formatUptime(status.startedAt), icon: Activity, accent: 'cyan' },
      { label: 'Conexões hoje', value: String(status.connectionsToday), icon: Radio, accent: 'blue' },
      { label: 'Estudos armazenados', value: String(status.studiesStored), icon: Database, accent: 'violet' },
      { label: 'Armazenamento usado', value: `${status.storageUsedGb} GB`, icon: HardDrive, accent: 'amber' },
    ],
    [status],
  );

  const accentMap: Record<string, string> = {
    emerald: 'bg-emerald-50 text-emerald-600 border-emerald-200',
    red: 'bg-red-50 text-red-500 border-red-200',
    cyan: 'bg-cyan-50 text-cyan-600 border-cyan-200',
    blue: 'bg-blue-50 text-blue-600 border-blue-200',
    violet: 'bg-violet-50 text-violet-600 border-violet-200',
    amber: 'bg-amber-50 text-amber-600 border-amber-200',
  };

  const simulateStore = () => {
    const devices = config.remoteDevices.filter((d) => d.enabled);
    if (devices.length === 0) {
      addLog('warning', 'Nenhum equipamento autorizado para simular C-STORE', 'UI');
      return;
    }
    const dev = devices[Math.floor(Math.random() * devices.length)];
    const count = 20 + Math.floor(Math.random() * 80);
    recordReceivedStudy(`${dev.aeTitle} (${dev.ip}:${dev.port})`, count);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-slate-900">Status do Servidor</h1>
          <span
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
              status.running ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${status.running ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
            {status.running ? 'Online' : 'Offline'}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-slate-50 p-6">
        <div className="mx-auto max-w-5xl space-y-6">
          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            {stats.map((s) => {
              const Icon = s.icon;
              return (
                <div key={s.label} className={`rounded-lg border p-4 ${accentMap[s.accent]}`}>
                  <Icon size={20} className="mb-2 opacity-80" />
                  <div className="text-2xl font-bold text-slate-900 tabular-nums">{s.value}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{s.label}</div>
                </div>
              );
            })}
          </div>

          {/* Server controls */}
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="mb-4 flex items-center gap-2">
              <Server size={18} className="text-cyan-600" />
              <h2 className="text-base font-semibold text-slate-900">Controle do SCP</h2>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={toggleServer}
                className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-white ${
                  status.running ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-500 hover:bg-emerald-600'
                }`}
              >
                {status.running ? <Square size={16} /> : <Play size={16} />}
                {status.running ? 'Parar Servidor' : 'Iniciar Servidor'}
              </button>

              <button
                onClick={simulateStore}
                disabled={!status.running}
                className="flex items-center gap-2 rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              >
                <Radio size={16} /> Simular C-STORE
              </button>

              <div className="ml-auto rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600 font-mono">
                {config.aeTitle} @ {config.listenIp}:{config.listenPort}
              </div>
            </div>
          </div>

          {/* Event log */}
          <div className="rounded-lg border border-slate-200 bg-white">
            <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-3">
              <Activity size={18} className="text-cyan-600" />
              <h2 className="text-base font-semibold text-slate-900">Log de Eventos</h2>
              <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{logs.length}</span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => {
                    const text = logs.map((l) => `[${l.timestamp}] ${l.level.toUpperCase()} ${l.source}: ${l.message}`).join('\n');
                    const blob = new Blob([text], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `pacs-log-${Date.now()}.txt`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
                >
                  <Download size={13} /> Exportar
                </button>
                <button
                  onClick={clearLogs}
                  className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
                >
                  <Trash2 size={13} /> Limpar
                </button>
              </div>
            </div>

            <div className="max-h-96 overflow-auto">
              {logs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-slate-400">
                  <Activity size={32} className="mb-2 opacity-40" />
                  <p className="text-sm">Nenhum evento registrado.</p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-slate-50">
                    {logs.map((entry) => {
                      const cfg = levelConfig[entry.level];
                      const Icon = cfg.icon;
                      return (
                        <tr key={entry.id} className="hover:bg-slate-50/50">
                          <td className="px-3 py-2 text-xs tabular-nums text-slate-400 whitespace-nowrap font-mono">
                            {formatTime(entry.timestamp)}
                          </td>
                          <td className="px-1 py-2">
                            <span className={`inline-flex items-center justify-center rounded ${cfg.bg} ${cfg.color} h-6 w-6`}>
                              <Icon size={13} />
                            </span>
                          </td>
                          <td className="px-2 py-2 text-xs font-mono text-slate-400 whitespace-nowrap">{entry.source}</td>
                          <td className="px-3 py-2 text-sm text-slate-700">{entry.message}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
