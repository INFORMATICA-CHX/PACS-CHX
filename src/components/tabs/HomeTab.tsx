import { useEffect, useState } from 'react';
import { Play, Square, ExternalLink, Monitor, FolderOpen, Globe, AlertCircle } from 'lucide-react';
import type { PacsStore } from '@/lib/usePacsStore';

interface HomeTabProps {
  store: PacsStore;
  onOpenViewer: () => void;
}

function formatUptime(startedAt: string | null): string {
  if (!startedAt) return '';
  const ms = Date.now() - new Date(startedAt).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `Uptime: ${h}h ${m}m`;
}

export function HomeTab({ store, onOpenViewer }: HomeTabProps) {
  const { status, config, setConfig, toggleServer, addLog } = store;
  const [importPath, setImportPath] = useState('');
  const [includeSubfolders, setIncludeSubfolders] = useState(true);
  const [importing, setImporting] = useState(false);
  const [viewerUser, setViewerUser] = useState(config.viewerUser);
  const [viewerPassword, setViewerPassword] = useState(config.viewerPassword);

  useEffect(() => {
    setViewerUser(config.viewerUser);
    setViewerPassword(config.viewerPassword);
  }, [config.viewerUser, config.viewerPassword]);

  const localUrl = `http://localhost:${config.apiPort ?? 4000}/viewer`;
  const networkUrl = `http://[IP_DA_MAQUINA]:${config.apiPort ?? 4000}/viewer`;

  const importDicomFiles = async () => {
    if (!importPath.trim()) return;
    setImporting(true);
    addLog('info', `Importacao iniciada: ${importPath}${includeSubfolders ? ' (com subpastas)' : ''}`, 'IMPORT');
    try {
      const response = await fetch(`http://127.0.0.1:${config.apiPort ?? 4000}/api/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: importPath.trim(), includeSubfolders }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Falha na importacao');
      addLog(
        result.failed ? 'warning' : 'success',
        `Importacao concluida: ${result.imported} de ${result.found} arquivo(s) DICOM importado(s)${result.failed ? `; ${result.failed} falha(s)` : ''}`,
        'IMPORT',
      );
    } catch (error) {
      addLog('error', `Falha na importacao: ${error instanceof Error ? error.message : 'erro desconhecido'}`, 'IMPORT');
    } finally {
      setImporting(false);
    }
  };

  const saveViewerLogin = async () => {
    const nextUser = viewerUser.trim() || 'admin';
    const nextPassword = viewerPassword || 'password';
    try {
      const saveResponse = await fetch(`http://127.0.0.1:${config.apiPort ?? 4000}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewerUser: nextUser, viewerPassword: nextPassword }),
      });
      if (!saveResponse.ok) throw new Error('Falha ao salvar');
      setViewerUser(nextUser);
      setViewerPassword(nextPassword);
      setConfig({ ...config, viewerUser: nextUser, viewerPassword: nextPassword });
      addLog('success', `Login do Viewer atualizado para o usuario ${nextUser}`, 'CONFIG');
    } catch {
      addLog('error', 'Nao foi possivel salvar o login: servidor indisponivel', 'CONFIG');
    }
  };

  return (
    <div className="space-y-4 p-5">
      {/* Windows Service */}
      <section className="rounded border border-gray-300 bg-white">
        <div className="border-b border-gray-300 bg-gray-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Serviço DICOM
        </div>
        <div className="flex items-center gap-4 px-4 py-3">
          <Monitor size={20} className="text-gray-500" />
          <span className="font-medium text-gray-800">DICOMApp</span>
          <span className={`ml-1 font-semibold ${status.running ? 'text-emerald-600' : 'text-red-500'}`}>
            {status.running ? 'Rodando' : 'Parado'}
          </span>
          {status.running && (
            <span className="text-xs text-gray-400 tabular-nums">{formatUptime(status.startedAt)}</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {status.running && (
              <div className="flex items-center gap-1.5 rounded bg-emerald-50 px-2.5 py-1 text-xs text-emerald-600">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                AE: {config.aeTitle} · Porta {config.listenPort}
              </div>
            )}
            <button
              onClick={toggleServer}
              className={`flex items-center gap-2 rounded border px-5 py-1.5 text-sm font-medium transition-colors ${
                status.running
                  ? 'border-gray-400 bg-gray-100 text-gray-700 hover:bg-gray-200'
                  : 'border-gray-400 bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {status.running ? <Square size={14} /> : <Play size={14} />}
              {status.running ? 'Parar' : 'Iniciar'}
            </button>
          </div>
        </div>
      </section>

      {/* Viewer */}
      <section className="rounded border border-gray-300 bg-white">
        <div className="border-b border-gray-300 bg-gray-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Visualizador Web
        </div>
        <div className="p-4 space-y-3">
          {!status.running && (
            <div className="flex items-center gap-2 rounded bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
              <AlertCircle size={14} />
              Inicie o servidor DICOM para habilitar o visualizador.
            </div>
          )}

          <div className="flex items-center gap-2">
            <div className="rounded border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm font-mono text-blue-600 flex-1">
              {localUrl}
            </div>
            <button
              disabled={!status.running}
              onClick={onOpenViewer}
              className="flex items-center gap-1.5 rounded border border-gray-400 bg-gray-100 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
            >
              <ExternalLink size={14} />
              Abrir Viewer
            </button>
          </div>

          <div>
            <div className="mb-1 text-xs text-gray-500">Acesso pela rede local</div>
            <div className="flex items-center gap-2">
              <div className="rounded border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm font-mono text-gray-500 flex-1">
                {networkUrl}
              </div>
              <button
                disabled={!status.running}
                className="flex items-center gap-1.5 rounded border border-gray-400 bg-gray-100 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
                onClick={onOpenViewer}
              >
                <Globe size={14} />
                Abrir Viewer
              </button>
            </div>
          </div>

          <div className="rounded border border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-600">
            <div className="mb-2 font-semibold text-gray-700">Login do Viewer</div>
            <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
              <label className="block">
                <span className="mb-1 block text-gray-500">ID padrao</span>
                <input
                  value={viewerUser}
                  onChange={(e) => setViewerUser(e.target.value)}
                  className="w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-sm text-gray-800 focus:border-blue-500 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-gray-500">Senha</span>
                <input
                  type="text"
                  value={viewerPassword}
                  onChange={(e) => setViewerPassword(e.target.value)}
                  className="w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-sm text-gray-800 focus:border-blue-500 focus:outline-none"
                />
              </label>
              <button
                onClick={saveViewerLogin}
                className="self-end rounded border border-gray-400 bg-gray-100 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200"
              >
                Salvar login
              </button>
            </div>
            <div className="mt-2 text-amber-600">Essas credenciais serao solicitadas antes da Worklist DICOM.</div>
          </div>
        </div>
      </section>

      {/* Import DICOM */}
      <section className="rounded border border-gray-300 bg-white">
        <div className="border-b border-gray-300 bg-gray-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Importar Arquivo DICOM
        </div>
        <div className="p-4 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={importPath}
              onChange={(e) => setImportPath(e.target.value)}
              placeholder="Caminho da pasta ou arquivo .dcm..."
              className="flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            />
            <button
              onClick={async () => {
                const folder = await window.localPacs?.openFolder();
                if (folder) setImportPath(folder);
              }}
              className="flex items-center gap-1.5 rounded border border-gray-400 bg-gray-100 px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-200"
            >
              <FolderOpen size={14} />
              Procurar...
            </button>
          </div>
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeSubfolders}
                onChange={(e) => setIncludeSubfolders(e.target.checked)}
                className="rounded border-gray-300"
              />
              Incluir subpastas
            </label>
            <button
              onClick={importDicomFiles}
              disabled={!importPath.trim() || importing}
              className="rounded border border-gray-400 bg-gray-100 px-5 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {importing ? 'Importando...' : 'Importar'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
