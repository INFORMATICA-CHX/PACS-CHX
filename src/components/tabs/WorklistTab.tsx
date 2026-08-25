import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardPlus, RefreshCw, Trash2 } from 'lucide-react';
import type { PacsStore } from '@/lib/usePacsStore';
import { apiFetch } from '@/lib/apiClient';

interface WorklistItem {
  id: number;
  patient_id: string;
  patient_name: string;
  birth_date: string;
  sex: string;
  accession_number: string;
  modality: string;
  requested_procedure: string;
  scheduled_date: string;
  scheduled_time: string;
  referring_physician: string;
  target_devices: string[];
  sent_devices: Array<{ aeTitle: string; success: boolean; message: string; at: string }>;
  status: string;
}

const emptyForm = {
  patientId: '',
  patientName: '',
  birthDate: '',
  sex: 'M',
  accessionNumber: '',
  modality: 'CR',
  requestedProcedure: '',
  scheduledDate: new Date().toISOString().slice(0, 10),
  scheduledTime: '',
  referringPhysician: '',
  targetDevices: [] as string[],
};

export function WorklistTab({ store }: { store: PacsStore }) {
  const { config, addLog } = store;
  const currentPort = window.location.port ? Number(window.location.port) : (window.location.protocol === 'https:' ? 443 : 80);
  const api = (window.location.protocol === 'http:' || window.location.protocol === 'https:') && currentPort === Number(config.apiPort)
    ? window.location.origin
    : `http://127.0.0.1:${config.apiPort}`;
  const [items, setItems] = useState<WorklistItem[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const devices = useMemo(() => (config.remoteDevices ?? []).filter((device) => device.enabled && device.kind !== 'printer' && device.forWorklist !== false), [config.remoteDevices]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiFetch(`${api}/api/worklist`);
      const result = await response.json().catch(() => ([]));
      if (!response.ok) throw new Error(result.error ?? 'Nao foi possivel carregar a Worklist.');
      setItems(result);
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Falha ao carregar Worklist';
      setMessage({ kind: 'error', text });
      addLog('error', text, 'WORKLIST');
    } finally {
      setLoading(false);
    }
  }, [addLog, api]);

  useEffect(() => { void load(); }, [load]);

  const update = (key: keyof typeof emptyForm, value: string | string[]) => setForm((current) => ({ ...current, [key]: value }));
  const toggleDevice = (id: string) => setForm((current) => ({
    ...current,
    targetDevices: current.targetDevices.includes(id) ? current.targetDevices.filter((item) => item !== id) : [...current.targetDevices, id],
  }));

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      if (!form.patientId.trim() || !form.patientName.trim()) throw new Error('Informe ID e nome do paciente.');
      const response = await apiFetch(`${api}/api/worklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'Nao foi possivel cadastrar.');
      const text = 'Worklist cadastrada e disponivel para consulta do equipamento.';
      setMessage({ kind: 'success', text });
      addLog('success', text, 'WORKLIST');
      setForm({ ...emptyForm, scheduledDate: new Date().toISOString().slice(0, 10) });
      await load();
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Falha ao cadastrar Worklist';
      setMessage({ kind: 'error', text });
      addLog('error', text, 'WORKLIST');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: WorklistItem) => {
    if (!window.confirm(`Excluir Worklist de ${item.patient_name}?`)) return;
    setMessage(null);
    try {
      const response = await apiFetch(`${api}/api/worklist/${item.id}`, { method: 'DELETE' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'Nao foi possivel excluir.');
      const text = 'Worklist excluida.';
      setMessage({ kind: 'success', text });
      addLog('success', `${text} ${item.patient_name}`, 'WORKLIST');
      await load();
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Falha ao excluir Worklist';
      setMessage({ kind: 'error', text });
      addLog('error', text, 'WORKLIST');
    }
  };

  const input = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500';
  return <div className="space-y-4 p-5">
    {message && <div className={`rounded-xl border px-4 py-3 text-sm ${message.kind === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>{message.text}</div>}
    <section className="rounded-xl border bg-white">
      <div className="flex items-center gap-2 border-b px-4 py-3 text-xs font-semibold uppercase text-slate-500"><ClipboardPlus size={15}/> Cadastro de Worklist</div>
      <div className="grid gap-3 p-4 md:grid-cols-4">
        <input className={input} placeholder="ID do paciente" value={form.patientId} onChange={(e) => update('patientId', e.target.value)}/>
        <input className={input} placeholder="Nome do paciente" value={form.patientName} onChange={(e) => update('patientName', e.target.value)}/>
        <input className={input} type="date" value={form.birthDate} onChange={(e) => update('birthDate', e.target.value)}/>
        <select className={input} value={form.sex} onChange={(e) => update('sex', e.target.value)}><option>M</option><option>F</option><option>O</option></select>
        <input className={input} placeholder="Accession" value={form.accessionNumber} onChange={(e) => update('accessionNumber', e.target.value)}/>
        <select className={input} value={form.modality} onChange={(e) => update('modality', e.target.value)}><option>CR</option><option>DR</option><option>DX</option><option>MG</option><option>CT</option><option>MR</option></select>
        <input className={input} type="date" value={form.scheduledDate} onChange={(e) => update('scheduledDate', e.target.value)}/>
        <input className={input} type="time" value={form.scheduledTime} onChange={(e) => update('scheduledTime', e.target.value)}/>
        <input className={`${input} md:col-span-2`} placeholder="Procedimento solicitado" value={form.requestedProcedure} onChange={(e) => update('requestedProcedure', e.target.value)}/>
        <input className={`${input} md:col-span-2`} placeholder="Medico solicitante" value={form.referringPhysician} onChange={(e) => update('referringPhysician', e.target.value)}/>
      </div>
      <div className="border-t px-4 py-3">
        <div className="mb-2 text-xs font-semibold uppercase text-slate-500">Equipamentos de destino</div>
        <div className="flex flex-wrap gap-2">
          {devices.map((device) => <label key={device.id} className="flex items-center gap-2 rounded-lg border bg-slate-50 px-3 py-2 text-xs text-slate-700">
            <input type="checkbox" checked={form.targetDevices.includes(device.id)} onChange={() => toggleDevice(device.id)}/>
            <span className="font-semibold">{device.description || device.aeTitle}</span><span className="font-mono text-slate-400">{device.aeTitle} · {device.ip}:{device.port}</span>
          </label>)}
          {!devices.length && <span className="text-xs text-amber-600">Cadastre equipamentos ativos na aba Conexoes.</span>}
        </div>
        <div className="mt-3 flex justify-end"><button disabled={saving || !form.patientId.trim() || !form.patientName.trim()} onClick={() => void save()} className="flex items-center gap-2 bg-blue-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"><ClipboardPlus size={15}/>{saving ? 'Cadastrando...' : 'Cadastrar Worklist'}</button></div>
      </div>
    </section>
    <section className="overflow-hidden rounded-xl border bg-white">
      <div className="flex items-center gap-2 border-b px-4 py-3 text-xs font-semibold uppercase text-slate-500"><RefreshCw size={15}/> Worklists cadastradas {loading && <span className="text-blue-600">carregando...</span>}</div>
      <div className="overflow-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase text-slate-500"><tr><th className="px-4 py-3">Paciente</th><th>Exame</th><th>Agenda</th><th>Status</th><th className="pr-4 text-right">Acoes</th></tr></thead>
          <tbody>{items.map((item) => <tr key={item.id} className="border-t">
            <td className="px-4 py-3"><b className="block text-slate-800">{item.patient_name}</b><span className="text-xs text-slate-500">{item.patient_id}</span></td>
            <td><b className="font-mono text-blue-700">{item.modality}</b><span className="ml-2">{item.requested_procedure || item.accession_number}</span><div className="text-xs text-slate-500">{item.accession_number}</div></td>
            <td>{item.scheduled_date} {item.scheduled_time}</td>
            <td><span className={`rounded-full px-2 py-1 text-xs font-semibold ${item.status === 'sent' ? 'bg-emerald-50 text-emerald-700' : item.status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-600'}`}>{item.status === 'sent' ? 'Disponivel' : item.status === 'failed' ? 'Falhou' : 'Cadastrado'}</span></td>
            <td className="pr-4 text-right"><button title="Excluir Worklist" onClick={() => void remove(item)} className="inline-flex items-center justify-center rounded-lg border border-red-200 p-2 text-red-600 hover:bg-red-50"><Trash2 size={15}/></button></td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>
  </div>;
}
