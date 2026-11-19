import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ClipboardPlus, RefreshCw, Search, Trash2 } from 'lucide-react';
import type { PacsStore } from '@/lib/usePacsStore';
import { apiFetch } from '@/lib/apiClient';
import { WorklistMappingAdmin, type WorklistCatalog } from '@/components/tabs/WorklistMappingAdmin';
import { konicaProjection, translateKonicaDescription } from '@/components/tabs/konicaTranslation';

interface WorklistItem {
  id: number;
  patient_id: string;
  patient_name: string;
  birth_date: string;
  sex: string;
  accession_number: string;
  modality: string;
  requested_procedure: string;
  ris_code?: string;
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
  risCode: '',
  requestedProcedureCode: '',
  selectedIncidenceIds: [] as number[],
  contrastFlag: false,
  scheduledDate: new Date().toISOString().slice(0, 10),
  scheduledTime: '',
  referringPhysician: '',
  targetDevices: [] as string[],
};

function incidenceDisplayName(examDescription: string, incident: WorklistCatalog['incidents'][number]) {
  const generatedPrefix = `${examDescription.trim()} - `;
  if (incident.description.startsWith(generatedPrefix)) {
    return konicaProjection(incident.protocol_code).name;
  }
  return incident.description || konicaProjection(incident.protocol_code).name;
}

function mappingDisplayName(mapping?: WorklistCatalog['mappings'][number]) {
  if (!mapping) return '';
  return mapping.source_name?.toLowerCase().includes('konica') || /^x-ray[\s,;:-]/i.test(mapping.received_description)
    ? translateKonicaDescription(mapping.received_description)
    : mapping.received_description;
}

export function WorklistTab({ store, userRole }: { store: PacsStore; userRole: string }) {
  const { config, addLog } = store;
  // The Express server serves the frontend and API from the same origin. Using
  // that origin also preserves HTTPS for remote clients; calling loopback over
  // HTTP from an HTTPS page is blocked as mixed content.
  const api = (window.location.protocol === 'http:' || window.location.protocol === 'https:')
    ? window.location.origin
    : `http://127.0.0.1:${Number(config.apiPort) || 4000}`;
  const [items, setItems] = useState<WorklistItem[]>([]);
  const [catalog, setCatalog] = useState<WorklistCatalog>({ modalities: [], mappings: [], incidents: [], unmapped: [], profiles: [], equipment: [], findLogs: [] });
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [view, setView] = useState<'registration' | 'mapping'>('registration');
  const [examPickerOpen, setExamPickerOpen] = useState(false);
  const [examSearch, setExamSearch] = useState('');
  const isMaster = userRole === 'master';

  const devices = useMemo(() => (config.remoteDevices ?? []).filter((device) => device.enabled && device.kind !== 'printer' && device.forWorklist !== false), [config.remoteDevices]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [worklistResponse, catalogResponse] = await Promise.all([apiFetch(`${api}/api/worklist`), apiFetch(`${api}/api/worklist/catalog`)]);
      const result = await worklistResponse.json().catch(() => ([]));
      const catalogResult = await catalogResponse.json().catch(() => ({}));
      if (!worklistResponse.ok) throw new Error(result.error ?? 'Nao foi possivel carregar a Worklist.');
      if (!catalogResponse.ok) throw new Error(catalogResult.error ?? 'Nao foi possivel carregar os mapeamentos.');
      setItems(result); setCatalog(catalogResult);
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
  const selectRisCode = (risCode: string) => {
    const mapping = catalog.mappings.find((entry) => entry.ris_code === risCode);
    setForm((current) => ({
      ...current, risCode, requestedProcedureCode: risCode,
      requestedProcedure: mappingDisplayName(mapping) || current.requestedProcedure,
      modality: mapping?.modality || current.modality,
      selectedIncidenceIds: [],
    }));
    setExamSearch(risCode);
    setExamPickerOpen(false);
  };
  const toggleIncidence = (id: number) => setForm((current) => ({ ...current, selectedIncidenceIds: current.selectedIncidenceIds.includes(id) ? current.selectedIncidenceIds.filter((value) => value !== id) : [...current.selectedIncidenceIds, id] }));
  const selectedIncidents = catalog.incidents.filter((entry) => entry.ris_code === form.risCode);
  const filteredMappings = useMemo(() => {
    const query = examSearch.trim().toLocaleLowerCase('pt-BR');
    return catalog.mappings.filter((mapping) => {
      if (!mapping.active) return false;
      if (!query) return true;
      if (mapping.ris_code.toLocaleLowerCase('pt-BR').includes(query) || mapping.received_description.toLocaleLowerCase('pt-BR').includes(query) || mappingDisplayName(mapping).toLocaleLowerCase('pt-BR').includes(query)) return true;
      return catalog.incidents.some((incident) => incident.ris_code === mapping.ris_code && `${incident.description} ${incident.protocol_code} ${incident.body_part} ${incident.view_position} ${incident.laterality}`.toLocaleLowerCase('pt-BR').includes(query));
    });
  }, [catalog.incidents, catalog.mappings, examSearch]);
  const mappedExamNeedsSelection = selectedIncidents.length > 0 && form.selectedIncidenceIds.length === 0;
  const displayWorklistProcedure = (item: WorklistItem) => {
    const mapping = catalog.mappings.find((entry) => entry.ris_code === item.ris_code);
    if (mapping?.source_name?.toLowerCase().includes('konica')) return mappingDisplayName(mapping);
    if (/^x-ray[\s,;:-]/i.test(item.requested_procedure || '')) return translateKonicaDescription(item.requested_procedure);
    return item.requested_procedure || item.accession_number;
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      if (!form.patientId.trim() || !form.patientName.trim()) throw new Error('Informe ID e nome do paciente.');
      if (mappedExamNeedsSelection) throw new Error('Selecione pelo menos uma incidencia do exame.');
      const response = await apiFetch(`${api}/api/worklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'Nao foi possivel cadastrar.');
      const text = result.unmapped
        ? 'Codigo ainda nao mapeado. O pedido foi preservado na fila e sera liberado automaticamente apos o mapeamento.'
        : `${Number(result.entries) || 1} incidencia(s) cadastrada(s) e disponivel(is) para consulta.`;
      setMessage({ kind: 'success', text });
      addLog('success', text, 'WORKLIST');
      setForm({ ...emptyForm, scheduledDate: new Date().toISOString().slice(0, 10) });
      setExamSearch('');
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
    <div className="flex gap-2 rounded-xl border bg-white p-2">
      <button onClick={() => setView('registration')} className={`rounded-lg px-4 py-2 text-sm font-semibold ${view === 'registration' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>Cadastro Worklist</button>
      {isMaster && <button onClick={() => setView('mapping')} className={`rounded-lg px-4 py-2 text-sm font-semibold ${view === 'mapping' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>Configurar mapeamento</button>}
    </div>
    {message && <div className={`rounded-xl border px-4 py-3 text-sm ${message.kind === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>{message.text}</div>}
    {view === 'registration' && <>
    <section className="rounded-xl border bg-white">
      <div className="flex items-center gap-2 border-b px-4 py-3 text-xs font-semibold uppercase text-slate-500"><ClipboardPlus size={15}/> Cadastro de Worklist</div>
      <div className="grid gap-3 p-4 md:grid-cols-4">
        <input className={input} placeholder="ID do paciente" value={form.patientId} onChange={(e) => update('patientId', e.target.value)}/>
        <input className={input} placeholder="Nome do paciente" value={form.patientName} onChange={(e) => update('patientName', e.target.value)}/>
        <input className={input} type="date" value={form.birthDate} onChange={(e) => update('birthDate', e.target.value)}/>
        <select className={input} value={form.sex} onChange={(e) => update('sex', e.target.value)}><option>M</option><option>F</option><option>O</option></select>
        <input className={input} placeholder="Accession" value={form.accessionNumber} onChange={(e) => update('accessionNumber', e.target.value)}/>
        <div className="relative">
          <div className="flex rounded-lg border border-slate-300 bg-white focus-within:border-blue-500">
            <Search size={16} className="ml-3 mt-2.5 shrink-0 text-slate-400"/>
            <input className="min-w-0 flex-1 px-2 py-2 text-sm outline-none" placeholder="Codigo RIS / exame / incidencia" value={examSearch} onFocus={() => setExamPickerOpen(true)} onChange={(event) => {
              const value = event.target.value;
              setExamSearch(value);
              setExamPickerOpen(true);
              const exact = catalog.mappings.find((entry) => entry.ris_code === value.trim());
              if (exact) selectRisCode(exact.ris_code);
              else setForm((current) => ({ ...current, risCode: value, requestedProcedureCode: value, selectedIncidenceIds: [] }));
            }}/>
            <button type="button" onClick={() => setExamPickerOpen((open) => !open)} className="px-3 text-slate-500" title="Abrir lista de exames e incidencias"><ChevronDown size={17}/></button>
          </div>
          {examPickerOpen && <div className="absolute z-40 mt-1 max-h-[420px] w-[min(720px,90vw)] overflow-auto rounded-lg border border-blue-200 bg-white p-2 shadow-2xl">
            <div className="sticky top-0 z-10 mb-2 flex items-center justify-between rounded bg-blue-50 px-3 py-2 text-xs text-blue-900"><b>{filteredMappings.length} exame(s) encontrado(s)</b><button type="button" onClick={() => setExamPickerOpen(false)} className="rounded border border-blue-200 bg-white px-2 py-1">Fechar</button></div>
            {filteredMappings.map((mapping) => {
              const incidents = catalog.incidents.filter((incident) => incident.ris_code === mapping.ris_code);
              return <button type="button" key={mapping.ris_code} onClick={() => selectRisCode(mapping.ris_code)} className="mb-2 block w-full rounded-lg border px-3 py-2 text-left hover:border-blue-400 hover:bg-blue-50">
                <div className="flex items-start gap-2"><b className="font-mono text-blue-700">{mapping.ris_code}</b><span className="text-xs font-semibold text-slate-800">{mappingDisplayName(mapping)}</span>{mapping.source_name && <span className="shrink-0 rounded bg-blue-100 px-2 py-0.5 text-[9px] font-semibold text-blue-700">{mapping.source_name}</span>}<span className="ml-auto shrink-0 rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">{incidents.length} incidencia(s)</span></div>
                <div className="mt-1 space-y-0.5 pl-1">{incidents.map((incident) => <div key={incident.id} title={`Codigo Konica: ${incident.protocol_code}`} className="text-[11px] font-medium text-slate-600">• {incidenceDisplayName(mapping.received_description, incident)}</div>)}</div>
              </button>;
            })}
            {!filteredMappings.length && <div className="p-4 text-center text-xs text-slate-500">Nenhum exame ou incidencia encontrado.</div>}
          </div>}
        </div>
        <select className={input} value={form.modality} onChange={(e) => update('modality', e.target.value)}>{catalog.modalities.filter((entry) => entry.active).map((entry) => <option key={entry.id}>{entry.dicom_code}</option>)}</select>
        <input className={input} type="date" value={form.scheduledDate} onChange={(e) => update('scheduledDate', e.target.value)}/>
        <input className={input} type="time" value={form.scheduledTime} onChange={(e) => update('scheduledTime', e.target.value)}/>
        <input className={`${input} md:col-span-2`} placeholder="Procedimento solicitado" value={form.requestedProcedure} onChange={(e) => update('requestedProcedure', e.target.value)}/>
        <input className={`${input} md:col-span-2`} placeholder="Medico solicitante" value={form.referringPhysician} onChange={(e) => update('referringPhysician', e.target.value)}/>
        {selectedIncidents.length > 0 && <div className="md:col-span-4 rounded-lg border-2 border-blue-200 bg-blue-50 p-3">
          <div className="mb-3 flex flex-wrap items-center gap-2"><div><div className="text-xs font-bold uppercase text-blue-800">Selecione as incidencias desejadas</div><div className="mt-0.5 text-[11px] text-blue-700">Exame {form.risCode} · {form.selectedIncidenceIds.length} de {selectedIncidents.length} selecionada(s)</div></div><button type="button" onClick={() => setForm((current) => ({ ...current, selectedIncidenceIds: selectedIncidents.map((incident) => incident.id) }))} className="ml-auto rounded border border-blue-300 bg-white px-3 py-1.5 text-xs font-semibold text-blue-800">Selecionar todas</button><button type="button" onClick={() => setForm((current) => ({ ...current, selectedIncidenceIds: [] }))} className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs">Limpar</button></div>
          <div className="grid gap-2 md:grid-cols-2">{selectedIncidents.map((incident) => <label key={incident.id} title={`Codigo Konica armazenado: ${incident.protocol_code}`} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-xs ${form.selectedIncidenceIds.includes(incident.id) ? 'border-blue-500 bg-blue-100' : 'border-slate-200 bg-white hover:border-blue-300'}`}><input className="h-4 w-4 accent-blue-600" type="checkbox" checked={form.selectedIncidenceIds.includes(incident.id)} onChange={() => toggleIncidence(incident.id)}/><b className="text-slate-800">{incidenceDisplayName(catalog.mappings.find((mapping) => mapping.ris_code === form.risCode)?.received_description || form.requestedProcedure, incident)}</b></label>)}</div>
          {mappedExamNeedsSelection && <div className="mt-2 text-xs font-semibold text-amber-700">Marque pelo menos uma incidencia para cadastrar a Worklist.</div>}
        </div>}
        {form.modality === 'CT' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.contrastFlag} onChange={(e) => setForm((current) => ({ ...current, contrastFlag: e.target.checked }))}/> Protocolo com contraste</label>}
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
        <div className="mt-3 flex justify-end"><button disabled={saving || !form.patientId.trim() || !form.patientName.trim() || mappedExamNeedsSelection} onClick={() => void save()} className="flex items-center gap-2 bg-blue-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"><ClipboardPlus size={15}/>{saving ? 'Cadastrando...' : 'Cadastrar Worklist'}</button></div>
      </div>
    </section>
    <section className="overflow-hidden rounded-xl border bg-white">
      <div className="flex items-center gap-2 border-b px-4 py-3 text-xs font-semibold uppercase text-slate-500"><RefreshCw size={15}/> Worklists cadastradas {loading && <span className="text-blue-600">carregando...</span>}</div>
      <div className="overflow-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase text-slate-500"><tr><th className="px-4 py-3">Paciente</th><th>Exame</th><th>Agenda</th><th>Status</th><th className="pr-4 text-right">Acoes</th></tr></thead>
          <tbody>{items.map((item) => <tr key={item.id} className="border-t">
            <td className="px-4 py-3"><b className="block text-slate-800">{item.patient_name}</b><span className="text-xs text-slate-500">{item.patient_id}</span></td>
            <td><b className="font-mono text-blue-700">{item.modality}</b><span className="ml-2">{displayWorklistProcedure(item)}</span><div className="text-xs text-slate-500">{item.accession_number}</div></td>
            <td>{item.scheduled_date} {item.scheduled_time}</td>
            <td><span className={`rounded-full px-2 py-1 text-xs font-semibold ${item.status === 'sent' ? 'bg-emerald-50 text-emerald-700' : item.status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-600'}`}>{item.status === 'sent' ? 'Disponivel' : item.status === 'failed' ? 'Falhou' : 'Cadastrado'}</span></td>
            <td className="pr-4 text-right"><button title="Excluir Worklist" onClick={() => void remove(item)} className="inline-flex items-center justify-center rounded-lg border border-red-200 p-2 text-red-600 hover:bg-red-50"><Trash2 size={15}/></button></td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>
    </>}
    {isMaster && view === 'mapping' && <WorklistMappingAdmin api={api} catalog={catalog} onChanged={load}/>}
  </div>;
}
