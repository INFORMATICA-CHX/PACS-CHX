import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Monitor, Plus, TestTube2, Trash2, XCircle } from 'lucide-react';
import type { PacsStore } from '@/lib/usePacsStore';
import type { ConnectionTestState, RemoteDevice, ServerConfig } from '@/types';

export function ConnectionTab({ store }: { store: PacsStore }) {
  const { config, setConfig, addLog } = store;
  const visibleNodes = (config.remoteDevices ?? []).filter((device) => device.kind !== 'printer');
  const [devices, setDevices] = useState(visibleNodes);
  const [states, setStates] = useState<Record<string, ConnectionTestState>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setDevices((config.remoteDevices ?? []).filter((device) => device.kind !== 'printer'));
  }, [config.remoteDevices, dirty]);

  const update = (id: string, patch: Partial<RemoteDevice>) => { setDevices((all) => all.map((d) => d.id === id ? { ...d, ...patch } : d)); setDirty(true); };
  const add = () => { setDevices((all) => [...all, { id: crypto.randomUUID(), kind: 'node', aeTitle: 'NOVO_AE', ip: '127.0.0.1', port: 11112, description: '', enabled: true, forPacs: true, forWorklist: true }]); setDirty(true); };

  const normalizeDevices = () => devices.map((device) => ({
    ...device,
    id: device.id || crypto.randomUUID(),
    kind: 'node' as const,
    aeTitle: device.aeTitle.trim().toUpperCase(),
    ip: device.ip.trim(),
    port: Number(device.port),
    description: device.description.trim(),
    enabled: Boolean(device.enabled),
    forPacs: device.forPacs !== false,
    forWorklist: device.forWorklist !== false,
  }));

  const save = async () => {
    const nodeDevices = normalizeDevices();
    const invalid = nodeDevices.find((device) => !device.aeTitle || !device.ip || device.port < 1 || device.port > 65535);
    if (invalid) {
      addLog('error', 'Confira AE Title, IP e porta dos equipamentos', 'CONFIG');
      return;
    }
    const printerDevices = (config.remoteDevices ?? []).filter((device) => device.kind === 'printer');
    const remoteDevices = [...nodeDevices, ...printerDevices];
    setSaving(true);
    try {
      const { viewerPassword: _viewerPassword, ...next } = { ...config, remoteDevices };
      const response = await fetch(`http://127.0.0.1:${config.apiPort}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'Falha ao salvar equipamentos');
      const saved = { ...config, ...result, viewerPassword: config.viewerPassword } as ServerConfig;
      setConfig(saved);
      setDevices(saved.remoteDevices ?? remoteDevices);
      setDirty(false);
      addLog('success', `${(saved.remoteDevices ?? remoteDevices).length} equipamento(s) salvo(s)`, 'CONFIG');
    } catch (error) { addLog('error', error instanceof Error ? error.message : 'Falha ao salvar', 'CONFIG'); }
    finally { setSaving(false); }
  };

  const test = async (device: RemoteDevice) => {
    setStates((s) => ({ ...s, [device.id]: 'testing' }));
    setMessages((current) => ({ ...current, [device.id]: 'Testando ping do IP...' }));
    try {
      const response = await fetch(`http://127.0.0.1:${config.apiPort}/api/test-echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(device) });
      const result = await response.json(); const ok = response.ok && (result.success || result.tcpReachable);
      const detail = formatTcpMessage(String(result.message ?? 'Sem resposta'));
      setStates((s) => ({ ...s, [device.id]: ok ? 'success' : 'failed' }));
      setMessages((current) => ({ ...current, [device.id]: detail }));
      addLog(result.success ? 'success' : ok ? 'warning' : 'error', `${device.aeTitle}: ${detail}`, 'CONNECTION');
    } catch { const detail = 'Servidor local indisponivel. Confira se o DICOM Server esta iniciado.'; setStates((s) => ({ ...s, [device.id]: 'failed' })); setMessages((current) => ({ ...current, [device.id]: detail })); addLog('error', `${device.aeTitle}: ${detail}`, 'CONNECTION'); }
  };

  const input = 'w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm outline-none focus:border-blue-500';
  return <div className="space-y-4 p-5"><section className="rounded-xl border bg-white"><div className="flex items-center gap-2 border-b px-4 py-3 text-xs font-semibold uppercase text-slate-500"><Monitor size={15}/> Nós DICOM autorizados</div><div className="space-y-3 p-4">
    {devices.map((device) => { const state = states[device.id] ?? 'idle'; return <div key={device.id} className="rounded-xl border border-slate-200 bg-slate-50/50 p-3"><div className="grid gap-2 md:grid-cols-[1.1fr_1fr_120px_1.5fr_auto]">
      <input className={`${input} font-mono`} value={device.aeTitle} onChange={(e) => update(device.id, { aeTitle: e.target.value.toUpperCase() })}/><input className={`${input} font-mono`} value={device.ip} onChange={(e) => update(device.id, { ip: e.target.value })}/><input className={input} type="number" value={device.port} onChange={(e) => update(device.id, { port: Number(e.target.value) })}/><input className={input} placeholder="Descrição" value={device.description} onChange={(e) => update(device.id, { description: e.target.value })}/><button title="Remover" onClick={() => { setDevices((all) => all.filter((d) => d.id !== device.id)); setDirty(true); }} className="p-2 text-slate-400 hover:text-red-600"><Trash2 size={16}/></button>
    </div><div className="mt-3 flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={device.enabled} onChange={(e) => update(device.id, { enabled: e.target.checked })}/> Ativo</label>
      <label className="flex items-center gap-2 text-xs text-slate-600" title="Autoriza este equipamento a enviar imagens (C-STORE) para o PACS"><input type="checkbox" checked={device.forPacs !== false} onChange={(e) => update(device.id, { forPacs: e.target.checked })}/> PACS (C-STORE)</label>
      <label className="flex items-center gap-2 text-xs text-slate-600" title="Disponibiliza este equipamento como destino ao cadastrar uma Worklist"><input type="checkbox" checked={device.forWorklist !== false} onChange={(e) => update(device.id, { forWorklist: e.target.checked })}/> Worklist (MWL)</label>
      <div className="ml-auto flex items-center gap-2">{state === 'success' && <span className="flex items-center gap-1 text-xs text-emerald-600"><CheckCircle2 size={14}/> Conectado</span>}{state === 'failed' && <span className="flex items-center gap-1 text-xs text-red-600"><XCircle size={14}/> Falhou</span>}<button onClick={() => void test(device)} disabled={state === 'testing'} className="flex items-center gap-2 border px-3 py-1.5 text-xs">{state === 'testing' ? <Loader2 className="animate-spin" size={14}/> : <TestTube2 size={14}/>} Testar ping</button></div>
    </div>{messages[device.id] && <div className={`mt-2 rounded-lg border px-3 py-2 text-xs ${state === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : state === 'testing' ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-red-200 bg-red-50 text-red-700'}`}>{messages[device.id]}</div>}</div>; })}
    <button onClick={add} className="flex items-center gap-2 border border-dashed px-4 py-2 text-sm text-blue-700"><Plus size={15}/> Adicionar equipamento</button>
  </div></section><div className="flex justify-end"><button disabled={!dirty || saving} onClick={() => void save()} className="bg-blue-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-40">{saving ? 'Salvando...' : 'Salvar equipamentos'}</button></div></div>;
}

function formatTcpMessage(message: string) {
  if (/IP respondeu ao ping/i.test(message)) return 'IP respondeu ao ping';
  if (/IP sem resposta/i.test(message)) return 'IP sem resposta ao ping. Confira rede, firewall e se o equipamento esta ligado.';
  if (/ECONNREFUSED/i.test(message)) return 'IP encontrado, mas a porta recusou conexao. Confira se o equipamento esta com o DICOM ativo nessa porta.';
  if (/ETIMEDOUT|timed out/i.test(message)) return 'Tempo esgotado. Confira IP, rede, firewall e se o equipamento esta ligado.';
  if (/EHOSTUNREACH|ENETUNREACH/i.test(message)) return 'Equipamento inacessivel pela rede. Confira IP e conectividade.';
  if (/TCP reachable/i.test(message)) return 'TCP conectado com sucesso';
  if (/Rede e porta acessiveis/i.test(message)) return message;
  return message;
}
