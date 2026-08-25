import { useEffect, useState } from 'react';
import {
  Save, Plus, Trash2, TestTube2, Network, HardDrive, Monitor, Shield,
  CheckCircle2, XCircle, Loader2, Wifi,
} from 'lucide-react';
import type { RemoteDevice, ServerConfig, ConnectionTestState } from '@/types';
import type { PacsStore } from '@/lib/usePacsStore';

interface SettingsProps {
  store: PacsStore;
}

export function Settings({ store }: SettingsProps) {
  const { config, setConfig, addLog } = store;
  const [local, setLocal] = useState<ServerConfig>(config);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testStates, setTestStates] = useState<Record<string, ConnectionTestState>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setLocal(config);
  }, [config, dirty]);

  const update = (patch: Partial<ServerConfig>) => {
    setLocal((prev) => ({ ...prev, ...patch }));
    setDirty(true);
    setSaved(false);
    setSaveError(null);
  };

  const updateDevice = (id: string, patch: Partial<RemoteDevice>) => {
    setLocal((prev) => ({
      ...prev,
      remoteDevices: prev.remoteDevices.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    }));
    setDirty(true);
    setSaved(false);
    setSaveError(null);
  };

  const addDevice = () => {
    const newDevice: RemoteDevice = {
      id: `rd${Date.now()}`,
      aeTitle: 'NOVO_EQUIPAMENTO',
      ip: '192.168.0.0',
      port: 11112,
      description: '',
      enabled: true,
    };
    setLocal((prev) => ({ ...prev, remoteDevices: [...prev.remoteDevices, newDevice] }));
    setDirty(true);
    setSaved(false);
    setSaveError(null);
  };

  const removeDevice = (id: string) => {
    setLocal((prev) => ({
      ...prev,
      remoteDevices: prev.remoteDevices.filter((d) => d.id !== id),
    }));
    setDirty(true);
    setSaved(false);
    setSaveError(null);
  };

  const handleSave = async () => {
    const remoteDevices = local.remoteDevices.map((device) => ({
      ...device,
      id: device.id || `rd${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      aeTitle: device.aeTitle.trim().toUpperCase(),
      ip: device.ip.trim(),
      port: Number(device.port),
      description: device.description.trim(),
      enabled: Boolean(device.enabled),
    }));
    const invalidDevice = remoteDevices.find((device) => !device.aeTitle || !device.ip || device.port < 1 || device.port > 65535);

    if (!local.aeTitle.trim() || [local.listenPort, local.apiPort].some((port) => port < 1 || port > 65535) || invalidDevice) {
      const message = 'Confira o AE Title e as portas informadas';
      setSaveError(message);
      addLog('error', message, 'CONFIG');
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSaved(false);
    const normalizedLocal = { ...local, remoteDevices };
    const { viewerPassword: _viewerPassword, ...payload } = normalizedLocal;

    try {
      const response = await fetch(`http://127.0.0.1:${config.apiPort ?? 4000}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'O servidor recusou a configuração');

      const nextConfig = { ...normalizedLocal, ...result, viewerPassword: local.viewerPassword } as ServerConfig;
      setLocal(nextConfig);
      setConfig(nextConfig);
      setDirty(false);
      setSaved(true);
      addLog('success', `Configurações salvas - AE Title: ${nextConfig.aeTitle}, porta ${nextConfig.listenPort}, ${nextConfig.remoteDevices.length} equipamentos`, 'CONFIG');
      setTimeout(() => setSaved(false), 2500);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao salvar configurações';
      setSaveError(message);
      addLog('error', message, 'CONFIG');
    } finally {
      setSaving(false);
    }
  };

  const testConnection = (device: RemoteDevice) => {
    setTestStates((prev) => ({ ...prev, [device.id]: 'testing' }));
    // Simulated C-ECHO - in the real backend this performs a DICOM C-ECHO
    // to the remote device and reports the round-trip result.
    setTimeout(() => {
      const reachable = device.port > 0 && device.ip.split('.').length === 4;
      setTestStates((prev) => ({
        ...prev,
        [device.id]: reachable ? 'success' : 'failed',
      }));
      addLog(
        reachable ? 'success' : 'error',
        `C-ECHO para ${device.aeTitle} (${device.ip}:${device.port}) - ${reachable ? 'respondeu OK' : 'sem resposta'}`,
        'SCP',
      );
      setTimeout(() => {
        setTestStates((prev) => ({ ...prev, [device.id]: 'idle' }));
      }, 4000);
    }, 1200);
  };

  const testTcpConnection = async (device: RemoteDevice) => {
    setTestStates((prev) => ({ ...prev, [device.id]: 'testing' }));
    try {
      const response = await fetch(`http://127.0.0.1:${config.apiPort ?? 4000}/api/test-echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(device),
      });
      const result = await response.json().catch(() => ({}));
      const reachable = response.ok && Boolean(result.success);
      setTestStates((prev) => ({ ...prev, [device.id]: reachable ? 'success' : 'failed' }));
      addLog(
        reachable ? 'success' : 'error',
        `Teste TCP para ${device.aeTitle} (${device.ip}:${device.port}) - ${formatTcpMessage(String(result.message ?? 'sem resposta'))}`,
        'SCP',
      );
    } catch {
      setTestStates((prev) => ({ ...prev, [device.id]: 'failed' }));
      addLog('error', `${device.aeTitle}: servidor indisponivel`, 'SCP');
    }
    setTimeout(() => {
      setTestStates((prev) => ({ ...prev, [device.id]: 'idle' }));
    }, 4000);
  };

  const fieldClass = 'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500';
  const labelClass = 'block text-sm font-medium text-slate-700 mb-1.5';

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 bg-white px-6 py-4">
        <h1 className="text-lg font-semibold text-slate-900">Configurações do Servidor</h1>
        <p className="text-sm text-slate-500 mt-0.5">Parâmetros de rede e equipamentos autorizados</p>
      </div>

      <div className="flex-1 overflow-auto bg-slate-50 p-6">
        <div className="mx-auto max-w-4xl space-y-6">
          {/* Network settings */}
          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="mb-4 flex items-center gap-2">
              <Network size={18} className="text-cyan-600" />
              <h2 className="text-base font-semibold text-slate-900">Rede DICOM</h2>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <label className={labelClass}>AE Title local</label>
                <input
                  type="text"
                  value={local.aeTitle}
                  onChange={(e) => update({ aeTitle: e.target.value.toUpperCase() })}
                  className={fieldClass}
                  placeholder="PACSCHX"
                />
                <p className="mt-1 text-xs text-slate-400">Nome do nosso PACS na rede DICOM</p>
              </div>
              <div>
                <label className={labelClass}>IP de escuta</label>
                <input
                  type="text"
                  value={local.listenIp}
                  onChange={(e) => update({ listenIp: e.target.value })}
                  className={fieldClass}
                  placeholder="0.0.0.0"
                />
                <p className="mt-1 text-xs text-slate-400">0.0.0.0 escuta em todas as interfaces</p>
              </div>
              <div>
                <label className={labelClass}>Porta de escuta</label>
                <input
                  type="number"
                  value={local.listenPort}
                  onChange={(e) => update({ listenPort: Number(e.target.value) })}
                  className={fieldClass}
                  min={1}
                  max={65535}
                />
                <p className="mt-1 text-xs text-slate-400">Padrão DICOM: 104 ou 11112</p>
              </div>
            </div>
          </section>

          {/* Storage settings */}
          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="mb-4 flex items-center gap-2">
              <HardDrive size={18} className="text-cyan-600" />
              <h2 className="text-base font-semibold text-slate-900">Armazenamento</h2>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className={labelClass}>Pasta de armazenamento DICOM</label>
                <input
                  type="text"
                  value={local.storagePath}
                  onChange={(e) => update({ storagePath: e.target.value })}
                  className={fieldClass}
                />
                <p className="mt-1 text-xs text-slate-400">Organizado por paciente/estudo/série</p>
              </div>
              <div>
                <label className={labelClass}>Caminho do banco de metadados</label>
                <input
                  type="text"
                  value={local.dbPath}
                  onChange={(e) => update({ dbPath: e.target.value })}
                  className={fieldClass}
                />
                <p className="mt-1 text-xs text-slate-400">SQLite para indexação rápida</p>
              </div>
            </div>
          </section>

          {/* Remote devices */}
          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="mb-4 flex items-center gap-2">
              <Monitor size={18} className="text-cyan-600" />
              <h2 className="text-base font-semibold text-slate-900">Equipamentos Remotos Autorizados</h2>
              <span className="ml-auto rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                {local.remoteDevices.filter((d) => d.enabled).length} ativos
              </span>
            </div>

            <div className="space-y-2">
              {local.remoteDevices.map((device) => {
                const testState = testStates[device.id] ?? 'idle';
                return (
                  <div
                    key={device.id}
                    className={`rounded-md border p-3 transition-colors ${
                      device.enabled ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-50 opacity-60'
                    }`}
                  >
                    <div className="grid grid-cols-12 items-center gap-3">
                      <div className="col-span-12 md:col-span-3">
                        <label className="text-xs text-slate-500">AE Title</label>
                        <input
                          type="text"
                          value={device.aeTitle}
                          onChange={(e) => updateDevice(device.id, { aeTitle: e.target.value.toUpperCase() })}
                          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono focus:border-cyan-500 focus:outline-none"
                        />
                      </div>
                      <div className="col-span-7 md:col-span-3">
                        <label className="text-xs text-slate-500">IP</label>
                        <input
                          type="text"
                          value={device.ip}
                          onChange={(e) => updateDevice(device.id, { ip: e.target.value })}
                          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono focus:border-cyan-500 focus:outline-none"
                        />
                      </div>
                      <div className="col-span-5 md:col-span-2">
                        <label className="text-xs text-slate-500">Porta</label>
                        <input
                          type="number"
                          value={device.port}
                          onChange={(e) => updateDevice(device.id, { port: Number(e.target.value) })}
                          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono focus:border-cyan-500 focus:outline-none"
                        />
                      </div>
                      <div className="col-span-12 md:col-span-4 flex items-center gap-2">
                        <div className="flex-1">
                          <label className="text-xs text-slate-500">Descrição</label>
                          <input
                            type="text"
                            value={device.description}
                            onChange={(e) => updateDevice(device.id, { description: e.target.value })}
                            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-cyan-500 focus:outline-none"
                          />
                        </div>
                      </div>

                      <div className="col-span-12 flex items-center gap-2 pt-1">
                        <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={device.enabled}
                            onChange={(e) => updateDevice(device.id, { enabled: e.target.checked })}
                            className="rounded border-slate-300 text-cyan-600 focus:ring-cyan-500"
                          />
                          Autorizado
                        </label>

                        <button
                          onClick={() => void testTcpConnection(device)}
                          disabled={testState === 'testing'}
                          className="ml-auto flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                        >
                          {testState === 'testing' ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <TestTube2 size={13} />
                          )}
                          Testar TCP
                        </button>

                        {testState === 'success' && (
                          <span className="flex items-center gap-1 text-xs font-medium text-emerald-600">
                            <CheckCircle2 size={14} /> OK
                          </span>
                        )}
                        {testState === 'failed' && (
                          <span className="flex items-center gap-1 text-xs font-medium text-red-500">
                            <XCircle size={14} /> Sem resposta
                          </span>
                        )}

                        <button
                          onClick={() => removeDevice(device.id)}
                          className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500"
                          title="Remover"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <button
              onClick={addDevice}
              className="mt-3 flex items-center gap-1.5 rounded-md border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-500 hover:border-cyan-400 hover:text-cyan-600"
            >
              <Plus size={16} /> Adicionar equipamento
            </button>
          </section>

          {/* Info note about whitelist */}
          <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <Shield size={18} className="mt-0.5 flex-shrink-0 text-amber-600" />
            <div className="text-sm text-amber-800">
              <p className="font-medium">Whitelist de origens DICOM</p>
              <p className="mt-1 text-amber-700">
                Apenas equipamentos marcados como "Autorizado" podem enviar estudos via C-STORE.
                Conexões de AE Titles desconhecidos serão rejeitadas e registradas no log.
              </p>
            </div>
          </div>

          {/* Save bar */}
          <div className="sticky bottom-0 flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <Wifi size={18} className="text-slate-400" />
            <div className="flex-1 text-sm text-slate-500">
              AE: <span className="font-mono font-medium text-slate-700">{local.aeTitle}</span>
              <span className="mx-2">-</span>
              Escutando em <span className="font-mono font-medium text-slate-700">{local.listenIp}:{local.listenPort}</span>
            </div>
            {saved && (
              <span className="flex items-center gap-1.5 text-sm font-medium text-emerald-600">
                <CheckCircle2 size={16} /> Salvo
              </span>
            )}
            {saveError && (
              <span className="text-sm font-medium text-red-600">
                {saveError}
              </span>
            )}
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 rounded-md bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:cursor-wait disabled:opacity-60"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {saving ? 'Salvando...' : 'Salvar Configurações'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatTcpMessage(message: string) {
  if (/ECONNREFUSED/i.test(message)) return 'IP encontrado, mas a porta recusou conexao. Confira se o equipamento esta com o DICOM ativo nessa porta.';
  if (/ETIMEDOUT|timed out/i.test(message)) return 'Tempo esgotado. Confira IP, rede, firewall e se o equipamento esta ligado.';
  if (/EHOSTUNREACH|ENETUNREACH/i.test(message)) return 'Equipamento inacessivel pela rede. Confira IP e conectividade.';
  if (/TCP reachable/i.test(message)) return 'TCP conectado com sucesso';
  return message;
}
