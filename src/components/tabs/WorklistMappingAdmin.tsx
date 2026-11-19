import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Download, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { apiFetch } from '@/lib/apiClient';

export interface WorklistCatalog {
  modalities: Array<{ id: number; dicom_code: string; name: string; active: number; required_rules: Record<string, boolean> }>;
  mappings: Array<{ ris_code: string; received_description: string; modality_id: number; modality: string; source_name?: string; active: number }>;
  incidents: Array<{ id: number; ris_code: string; sort_order: number; description: string; protocol_code: string; coding_scheme: string; code_meaning: string; body_part: string; view_position: string; laterality: string; observation: string }>;
  unmapped: Array<{ id: number; ris_code: string; received_description: string; status: string; created_at: string }>;
  profiles: Array<{ id: number; name: string; delivery_mode: string; menu_field: string; send_body_part: number; send_view_position: number; charset: string; remove_accents: number; accession_suffix: number; active: number }>;
  equipment: Array<{ id: number; name: string; ae_title: string; ip: string; brand: string; model: string; modality_id: number | null; modality: string; room_unit: string; profile_id: number; profile_name: string; active: number }>;
  findLogs: Array<{ id: number; source_ae: string; source_ip: string; filters: Record<string, string>; returned_count: number; returned_tags: string[]; status: string; created_at: string }>;
}

const blankIncident = { description: '', protocolCode: '', codingScheme: '99PACSCHX', codeMeaning: '', bodyPart: '', viewPosition: '', laterality: '', observation: '' };
type MappingIncident = typeof blankIncident;
type KonicaImportRow = { risCode: string; description: string; incidents: MappingIncident[] };

import { nameKonicaIncidences, translateKonicaDescription } from './konicaTranslation';
function parseKonicaDat(content: string): KonicaImportRow[] {
  const rawRows = content.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => {
    const fields = line.split('\t');
    return { risCode: (fields[1] ?? '').trim(), rawDescription: (fields[2] ?? '').trim(), protocolCodes: fields.slice(4).map((value) => value.trim()).filter(Boolean) };
  }).filter((row) => row.risCode && row.rawDescription && row.protocolCodes.length);
  const sideSets = new Map<string, Set<'L' | 'R'>>();
  const usedByUnsidedExam = new Set<string>();
  rawRows.forEach((row) => {
    const side = row.risCode.endsWith('L') ? 'L' : row.risCode.endsWith('R') ? 'R' : '';
    if (!side) { row.protocolCodes.forEach((code) => usedByUnsidedExam.add(code)); return; }
    row.protocolCodes.forEach((code) => {
      const sides = sideSets.get(code) || new Set<'L' | 'R'>();
      sides.add(side); sideSets.set(code, sides);
    });
  });
  const knownSideByCode = new Map<string, 'L' | 'R'>();
  sideSets.forEach((sides, code) => { if (sides.size === 1 && !usedByUnsidedExam.has(code)) knownSideByCode.set(code, [...sides][0]); });
  return rawRows.map((row) => {
    const description = translateKonicaDescription(row.rawDescription);
    const incidents = nameKonicaIncidences(row.protocolCodes, row.risCode, knownSideByCode).map((projection) => ({
      description: projection.name,
      protocolCode: projection.protocolCode,
      codingScheme: '99KONICA',
      codeMeaning: projection.name,
      bodyPart: '',
      viewPosition: projection.viewPosition,
      laterality: projection.side,
      observation: 'Importado do mapeamento CS-7 Konica',
    }));
    return { risCode: row.risCode, description, incidents };
  });
}

export function WorklistMappingAdmin({ api, catalog, onChanged }: { api: string; catalog: WorklistCatalog; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [mapping, setMapping] = useState({ sourceName: '', risCode: '', description: '', modalityId: 0, incidents: [{ ...blankIncident }] });
  const [konicaSourceName, setKonicaSourceName] = useState('Mapeamento base Konica');
  const [konicaModalityId, setKonicaModalityId] = useState(0);
  const [konicaPreview, setKonicaPreview] = useState<KonicaImportRow[]>([]);
  const [modality, setModality] = useState({ dicomCode: '', name: '' });
  const [profile, setProfile] = useState({ name: '', deliveryMode: 'one_per_incidence', menuField: 'scheduled_protocol_code', charset: 'ISO_IR 192', sendBodyPart: true, sendViewPosition: true, removeAccents: false, accessionSuffix: true });
  const [equipment, setEquipment] = useState({ name: '', aeTitle: '', ip: '', brand: '', model: '', modalityId: 0, roomUnit: '', profileId: 0 });
  const input = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500';

  const request = async (url: string, init?: RequestInit) => {
    const response = await apiFetch(`${api}${url}`, init);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Operacao recusada.');
    return result;
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setMessage(null);
    try { await action(); await onChanged(); }
    catch (error) { setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Falha na operacao.' }); }
    finally { setBusy(false); }
  };
  const saveMapping = () => run(async () => {
    if (!mapping.risCode.trim() || !mapping.modalityId || mapping.incidents.some((item) => !item.description.trim())) throw new Error('Informe codigo RIS, modalidade e descricao de cada incidencia.');
    await request('/api/worklist/mappings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mapping) });
    setMapping({ sourceName: mapping.sourceName, risCode: '', description: '', modalityId: mapping.modalityId, incidents: [{ ...blankIncident }] });
  });
  const loadKonicaBase = () => run(async () => {
    const response = await fetch('/konica-base-mapping.dat', { cache: 'no-store' });
    if (!response.ok) throw new Error('Nao foi possivel carregar a base Konica incluida no PACS.');
    const rows = parseKonicaDat(await response.text());
    if (!rows.length) throw new Error('O arquivo da Konica nao possui linhas validas.');
    setKonicaPreview(rows);
    setKonicaModalityId((current) => current || catalog.modalities.find((item) => item.dicom_code === 'CR')?.id || catalog.modalities.find((item) => item.dicom_code === 'DX')?.id || 0);
    setMessage({ kind: 'success', text: `Base Konica carregada para conferencia: ${rows.length} exames e ${rows.reduce((sum, row) => sum + row.incidents.length, 0)} protocolos.` });
  });
  const importKonicaBase = () => run(async () => {
    if (!konicaSourceName.trim() || !konicaModalityId) throw new Error('Informe o nome da base e a modalidade.');
    const result = await request('/api/worklist/mappings/import-konica', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceName: konicaSourceName, modalityId: konicaModalityId, rows: konicaPreview }) });
    setMessage({ kind: 'success', text: `${result.sourceName}: ${result.imported} exames importados, ${result.incidents} incidencias e ${result.skipped} codigos existentes preservados.` });
  });
  const updateKonicaRow = (index: number, patch: Partial<KonicaImportRow>) => setKonicaPreview((rows) => rows.map((row, position) => position === index ? { ...row, ...patch } : row));
  const updateKonicaIncident = (rowIndex: number, incidentIndex: number, patch: Partial<MappingIncident>) => setKonicaPreview((rows) => rows.map((row, position) => position === rowIndex ? { ...row, incidents: row.incidents.map((incident, itemPosition) => itemPosition === incidentIndex ? { ...incident, ...patch } : incident) } : row));
  useEffect(() => {
    if (catalog.modalities.length && !konicaPreview.length) void loadKonicaBase();
    // The bundled base is loaded once when the master opens this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog.modalities.length]);
  const exportCatalog = async (format: 'json' | 'csv') => {
    const response = await apiFetch(`${api}/api/worklist/catalog/export?format=${format}`);
    if (!response.ok) throw new Error('Nao foi possivel exportar.');
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `worklist-mapeamentos.${format}`; link.click(); URL.revokeObjectURL(url);
  };
  const importJson = (file?: File) => {
    if (!file) return;
    void run(async () => {
      const parsed = JSON.parse(await file.text()) as WorklistCatalog;
      for (const entry of parsed.mappings || []) {
        if (catalog.mappings.some((current) => current.ris_code === entry.ris_code)) continue;
        const modalityEntry = catalog.modalities.find((current) => current.dicom_code === entry.modality);
        if (!modalityEntry) continue;
        await request('/api/worklist/mappings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ risCode: entry.ris_code, description: entry.received_description, modalityId: modalityEntry.id, incidents: (parsed.incidents || []).filter((incident) => incident.ris_code === entry.ris_code) }),
        });
      }
    });
  };
  const editIncident = (incident: WorklistCatalog['incidents'][number]) => {
    const description = window.prompt('Descricao da incidencia:', incident.description);
    if (description === null || !description.trim()) return;
    const protocolCode = window.prompt('Codigo de protocolo:', incident.protocol_code) ?? incident.protocol_code;
    const bodyPart = window.prompt('Regiao anatomica (Body Part):', incident.body_part) ?? incident.body_part;
    const viewPosition = window.prompt('View Position:', incident.view_position) ?? incident.view_position;
    const laterality = window.prompt('Lateralidade (L/R):', incident.laterality) ?? incident.laterality;
    void run(async () => { await request(`/api/worklist/incidents/${incident.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...incident, description, protocolCode, bodyPart, viewPosition, laterality, sortOrder: incident.sort_order }) }); });
  };
  const moveIncident = (incident: WorklistCatalog['incidents'][number], delta: number) => run(async () => {
    await request(`/api/worklist/incidents/${incident.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...incident, sortOrder: Math.max(1, incident.sort_order + delta) }) });
  });

  return <section className="overflow-hidden rounded-xl border bg-white">
    <button className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-semibold uppercase text-slate-600" onClick={() => setOpen((value) => !value)}><span>Administracao de mapeamentos e incidencias</span><span>{catalog.mappings.length} exames · {catalog.unmapped.filter((item) => item.status === 'pending').length} nao mapeados</span></button>
    {open && <div className="space-y-4 border-t p-4">
      {message && <div className={`rounded-lg border p-3 text-sm ${message.kind === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>{message.text}</div>}
      <div className="flex flex-wrap gap-2">
        <button disabled={busy} className="flex items-center gap-2 rounded border border-blue-300 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-800 disabled:opacity-50" onClick={() => void loadKonicaBase()}><Upload size={14}/> Carregar mapeamento base Konica</button>
        <button className="flex items-center gap-2 rounded border px-3 py-2 text-xs" onClick={() => void exportCatalog('json')}><Download size={14}/> Exportar JSON</button>
        <button className="flex items-center gap-2 rounded border px-3 py-2 text-xs" onClick={() => void exportCatalog('csv')}><Download size={14}/> Exportar CSV</button>
        <label className="flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-xs"><Upload size={14}/> Importar JSON<input className="hidden" type="file" accept="application/json,.json" onChange={(event) => importJson(event.target.files?.[0])}/></label>
      </div>

      {konicaPreview.length > 0 && <div className="space-y-3 rounded-xl border-2 border-blue-300 bg-blue-50 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[240px] flex-1 text-xs font-semibold text-blue-900">Nome da base<input className={`${input} mt-1 bg-white`} value={konicaSourceName} onChange={(event) => setKonicaSourceName(event.target.value)}/></label>
          <label className="min-w-[220px] text-xs font-semibold text-blue-900">Modalidade de todos os exames<select className={`${input} mt-1 bg-white`} value={konicaModalityId || ''} onChange={(event) => setKonicaModalityId(Number(event.target.value))}><option value="">Selecione</option>{catalog.modalities.filter((entry) => entry.active && (entry.dicom_code === 'CR' || entry.dicom_code === 'DX')).map((entry) => <option key={entry.id} value={entry.id}>{entry.dicom_code} — {entry.name}</option>)}</select></label>
          <button disabled={busy || !konicaModalityId} onClick={() => void importKonicaBase()} className="rounded bg-blue-700 px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50">Confirmar importacao</button>
          <button onClick={() => setKonicaPreview([])} className="rounded border border-slate-300 bg-white px-4 py-2.5 text-sm">Fechar previa</button>
        </div>
        <div className="rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs text-slate-700"><b>{konicaPreview.length} exames</b> · <b>{konicaPreview.reduce((sum, row) => sum + row.incidents.length, 0)} protocolos</b>. Os campos Body Part e View Position permanecem vazios porque o arquivo CS-7 nao fornece esses valores separadamente.</div>
        <div className="max-h-[520px] space-y-2 overflow-auto rounded-lg border border-blue-200 bg-white p-2">
          {konicaPreview.map((row, rowIndex) => <details key={`${row.risCode}-${rowIndex}`} open={rowIndex === 0} className="rounded border bg-slate-50">
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-700"><span className="font-mono text-blue-700">{row.risCode}</span> — {row.description} <span className="text-slate-400">({row.incidents.length} protocolo(s))</span></summary>
            <div className="space-y-2 border-t p-3">
              <div className="grid gap-2 md:grid-cols-[180px_1fr]"><label className="text-[11px] font-semibold text-slate-600">Codigo RIS<input className={`${input} mt-1 bg-white font-mono`} value={row.risCode} onChange={(event) => updateKonicaRow(rowIndex, { risCode: event.target.value })}/></label><label className="text-[11px] font-semibold text-slate-600">Descricao recebida<input className={`${input} mt-1 bg-white`} value={row.description} onChange={(event) => updateKonicaRow(rowIndex, { description: event.target.value })}/></label></div>
              {row.incidents.map((incident, incidentIndex) => <div key={incidentIndex} className="grid gap-2 rounded border bg-white p-2 md:grid-cols-6">
                <label className="text-[10px] font-semibold text-slate-500 md:col-span-2">Descricao da incidencia<input className={`${input} mt-1`} value={incident.description} onChange={(event) => updateKonicaIncident(rowIndex, incidentIndex, { description: event.target.value })}/></label>
                <label className="text-[10px] font-semibold text-slate-500 md:col-span-2">Codigo protocolo Konica<input className={`${input} mt-1 font-mono`} value={incident.protocolCode} onChange={(event) => updateKonicaIncident(rowIndex, incidentIndex, { protocolCode: event.target.value })}/></label>
                <label className="text-[10px] font-semibold text-slate-500">Body Part<input className={`${input} mt-1`} value={incident.bodyPart} onChange={(event) => updateKonicaIncident(rowIndex, incidentIndex, { bodyPart: event.target.value.toUpperCase() })}/></label>
                <label className="text-[10px] font-semibold text-slate-500">View Position<input className={`${input} mt-1`} value={incident.viewPosition} onChange={(event) => updateKonicaIncident(rowIndex, incidentIndex, { viewPosition: event.target.value.toUpperCase() })}/></label>
                <label className="text-[10px] font-semibold text-slate-500">Lateralidade<input className={`${input} mt-1`} maxLength={2} value={incident.laterality} onChange={(event) => updateKonicaIncident(rowIndex, incidentIndex, { laterality: event.target.value.toUpperCase() })}/></label>
                <label className="text-[10px] font-semibold text-slate-500">Esquema<input className={`${input} mt-1 font-mono`} value={incident.codingScheme} onChange={(event) => updateKonicaIncident(rowIndex, incidentIndex, { codingScheme: event.target.value.toUpperCase() })}/></label>
              </div>)}
            </div>
          </details>)}
        </div>
      </div>}

      <div className="grid gap-3 rounded-xl border bg-slate-50 p-4 md:grid-cols-4">
        <input className={input} placeholder="Nova modalidade (ex.: NM)" value={modality.dicomCode} onChange={(e) => setModality((value) => ({ ...value, dicomCode: e.target.value.toUpperCase() }))}/>
        <input className={`${input} md:col-span-2`} placeholder="Nome da modalidade" value={modality.name} onChange={(e) => setModality((value) => ({ ...value, name: e.target.value }))}/>
        <button disabled={busy} className="rounded bg-slate-700 px-4 py-2 text-sm font-semibold text-white" onClick={() => void run(async () => { await request('/api/worklist/modalities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(modality) }); setModality({ dicomCode: '', name: '' }); })}>Adicionar modalidade</button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3 rounded-xl border p-4"><div className="text-xs font-semibold uppercase text-slate-500">Perfis de compatibilidade</div><input className={input} placeholder="Nome do novo perfil" value={profile.name} onChange={(e) => setProfile((value) => ({ ...value, name: e.target.value }))}/><div className="grid gap-2 md:grid-cols-2"><select className={input} value={profile.menuField} onChange={(e) => setProfile((value) => ({ ...value, menuField: e.target.value }))}><option value="scheduled_protocol_code">Scheduled Protocol Code</option><option value="requested_procedure_code">Requested Procedure Code</option><option value="step_description">Step Description</option><option value="requested_procedure_description">Requested Procedure Description</option></select><select className={input} value={profile.charset} onChange={(e) => setProfile((value) => ({ ...value, charset: e.target.value }))}><option>ISO_IR 192</option><option>ISO_IR 100</option></select></div><div className="flex flex-wrap gap-3 text-xs"><label><input type="checkbox" checked={profile.sendBodyPart} onChange={(e) => setProfile((value) => ({ ...value, sendBodyPart: e.target.checked }))}/> Body Part</label><label><input type="checkbox" checked={profile.sendViewPosition} onChange={(e) => setProfile((value) => ({ ...value, sendViewPosition: e.target.checked }))}/> View Position</label><label><input type="checkbox" checked={profile.removeAccents} onChange={(e) => setProfile((value) => ({ ...value, removeAccents: e.target.checked }))}/> Remover acentos</label></div><button disabled={busy || !profile.name.trim()} className="rounded bg-slate-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={() => void run(async () => { await request('/api/worklist/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile) }); setProfile((value) => ({ ...value, name: '' })); })}>Adicionar perfil</button><div className="text-xs text-slate-600">{catalog.profiles.map((item) => <div key={item.id} className="border-t py-2"><b>{item.name}</b> · {item.menu_field} · {item.charset}</div>)}</div></div>
        <div className="space-y-3 rounded-xl border p-4"><div className="text-xs font-semibold uppercase text-slate-500">Equipamentos MWL autorizados</div><div className="grid gap-2 md:grid-cols-2"><input className={input} placeholder="Nome / sala" value={equipment.name} onChange={(e) => setEquipment((value) => ({ ...value, name: e.target.value }))}/><input className={input} placeholder="AE Title" maxLength={16} value={equipment.aeTitle} onChange={(e) => setEquipment((value) => ({ ...value, aeTitle: e.target.value.toUpperCase() }))}/><input className={input} placeholder="IP" value={equipment.ip} onChange={(e) => setEquipment((value) => ({ ...value, ip: e.target.value }))}/><select className={input} value={equipment.profileId || ''} onChange={(e) => setEquipment((value) => ({ ...value, profileId: Number(e.target.value) }))}><option value="">Perfil</option>{catalog.profiles.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><button disabled={busy || !equipment.aeTitle || !equipment.profileId} className="rounded bg-slate-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={() => void run(async () => { await request('/api/worklist/equipment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(equipment) }); setEquipment((value) => ({ ...value, name: '', aeTitle: '', ip: '' })); })}>Autorizar equipamento</button><div className="text-xs">{catalog.equipment.map((item) => <div key={item.id} className="flex items-center justify-between border-t py-2"><span><b>{item.name}</b> · {item.ae_title}@{item.ip || '*'} · {item.profile_name}</span><span className="flex gap-2"><button className="rounded border px-2 py-1" title="Pre-visualizar dataset" onClick={() => void run(async () => { const preview = await request(`/api/worklist/preview?equipmentId=${item.id}`); window.alert(JSON.stringify(preview, null, 2)); })}>Pre-visualizar</button><button className="text-red-600" title="Excluir equipamento" onClick={() => { if (window.confirm(`Excluir ${item.name}?`)) void run(async () => { await request(`/api/worklist/equipment/${item.id}`, { method: 'DELETE' }); }); }}><Trash2 size={13}/></button></span></div>)}</div></div>
      </div>

      <div className="space-y-3 rounded-xl border p-4">
        <div className="grid gap-3 md:grid-cols-4"><input className={input} placeholder="Nome da base (opcional)" value={mapping.sourceName} onChange={(e) => setMapping((value) => ({ ...value, sourceName: e.target.value }))}/><input className={input} placeholder="Codigo RIS" value={mapping.risCode} onChange={(e) => setMapping((value) => ({ ...value, risCode: e.target.value }))}/><input className={input} placeholder="Descricao recebida" value={mapping.description} onChange={(e) => setMapping((value) => ({ ...value, description: e.target.value }))}/><select className={input} value={mapping.modalityId || ''} onChange={(e) => setMapping((value) => ({ ...value, modalityId: Number(e.target.value) }))}><option value="">Modalidade</option>{catalog.modalities.filter((entry) => entry.active).map((entry) => <option key={entry.id} value={entry.id}>{entry.dicom_code} — {entry.name}</option>)}</select></div>
        {mapping.incidents.map((incident, index) => <div key={index} className="grid gap-2 rounded-lg border bg-slate-50 p-3 md:grid-cols-6">
          <input className={`${input} md:col-span-2`} placeholder="Descricao da incidencia" value={incident.description} onChange={(e) => setMapping((value) => ({ ...value, incidents: value.incidents.map((item, position) => position === index ? { ...item, description: e.target.value } : item) }))}/>
          <input className={input} placeholder="Codigo protocolo" value={incident.protocolCode} onChange={(e) => setMapping((value) => ({ ...value, incidents: value.incidents.map((item, position) => position === index ? { ...item, protocolCode: e.target.value } : item) }))}/>
          <input className={input} placeholder="Body part" value={incident.bodyPart} onChange={(e) => setMapping((value) => ({ ...value, incidents: value.incidents.map((item, position) => position === index ? { ...item, bodyPart: e.target.value.toUpperCase() } : item) }))}/>
          <input className={input} placeholder="View position" value={incident.viewPosition} onChange={(e) => setMapping((value) => ({ ...value, incidents: value.incidents.map((item, position) => position === index ? { ...item, viewPosition: e.target.value.toUpperCase() } : item) }))}/>
          <div className="flex gap-2"><input className={input} placeholder="L/R" maxLength={2} value={incident.laterality} onChange={(e) => setMapping((value) => ({ ...value, incidents: value.incidents.map((item, position) => position === index ? { ...item, laterality: e.target.value.toUpperCase() } : item) }))}/><button title="Excluir incidencia" disabled={mapping.incidents.length === 1} onClick={() => setMapping((value) => ({ ...value, incidents: value.incidents.filter((_, position) => position !== index) }))} className="rounded border border-red-200 p-2 text-red-600 disabled:opacity-30"><Trash2 size={15}/></button></div>
        </div>)}
        <div className="flex justify-between"><button className="flex items-center gap-2 rounded border px-3 py-2 text-xs" onClick={() => setMapping((value) => ({ ...value, incidents: [...value.incidents, { ...blankIncident }] }))}><Plus size={14}/> Outra incidencia</button><button disabled={busy} className="rounded bg-blue-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={() => void saveMapping()}>Salvar mapeamento</button></div>
      </div>

      <div className="overflow-auto rounded-xl border"><table className="w-full text-left text-xs"><thead className="bg-slate-50 uppercase text-slate-500"><tr><th className="p-3">Codigo RIS</th><th>Base</th><th>Modalidade</th><th>Incidencias</th><th className="pr-3 text-right">Acoes</th></tr></thead><tbody>{catalog.mappings.map((entry) => <tr key={entry.ris_code} className="border-t align-top"><td className="p-3"><b>{entry.ris_code}</b><div className="text-slate-500">{entry.received_description}</div></td><td className="pt-3 text-blue-700">{entry.source_name || 'Manual'}</td><td className="pt-3">{entry.modality}</td><td className="py-2">{catalog.incidents.filter((incident) => incident.ris_code === entry.ris_code).map((incident) => <div key={incident.id} className="mb-1 flex items-center justify-between rounded border bg-slate-50 px-2 py-1"><span><b>{incident.sort_order}. {incident.description}</b> <span className="font-mono text-blue-700">{incident.protocol_code}</span> <span className="text-slate-500">{incident.body_part} {incident.view_position} {incident.laterality}</span></span><span className="ml-2 flex gap-1"><button title="Subir" onClick={() => void moveIncident(incident, -1)}><ArrowUp size={13}/></button><button title="Descer" onClick={() => void moveIncident(incident, 1)}><ArrowDown size={13}/></button><button title="Editar" onClick={() => editIncident(incident)}><Pencil size={13}/></button><button title="Excluir incidencia" className="text-red-600" onClick={() => { if (window.confirm(`Excluir incidencia ${incident.description}?`)) void run(async () => { await request(`/api/worklist/incidents/${incident.id}`, { method: 'DELETE' }); }); }}><Trash2 size={13}/></button></span></div>) || 'Sem incidencia'}</td><td className="pr-3 pt-2 text-right"><button title="Duplicar" className="mr-2 rounded border p-2" onClick={() => { const code = window.prompt('Novo codigo RIS:'); if (code) void run(async () => { await request(`/api/worklist/mappings/${encodeURIComponent(entry.ris_code)}/duplicate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ risCode: code }) }); }); }}><Copy size={14}/></button><button title="Excluir" className="rounded border border-red-200 p-2 text-red-600" onClick={() => { if (window.confirm(`Excluir ${entry.ris_code}?`)) void run(async () => { await request(`/api/worklist/mappings/${encodeURIComponent(entry.ris_code)}`, { method: 'DELETE' }); }); }}><Trash2 size={14}/></button></td></tr>)}</tbody></table></div>

      {catalog.unmapped.length > 0 && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><div className="mb-2 text-xs font-semibold uppercase text-amber-800">Fila de codigos nao mapeados</div>{catalog.unmapped.map((item) => <div key={item.id} className="flex justify-between border-t border-amber-200 py-2 text-sm"><span><b>{item.ris_code}</b> — {item.received_description || 'Sem descricao'}</span><span className="text-xs uppercase text-amber-700">{item.status}</span></div>)}</div>}
      <div className="rounded-xl border p-4"><div className="mb-2 text-xs font-semibold uppercase text-slate-500">Ultimas consultas C-FIND por equipamento</div>{catalog.findLogs.slice(0, 20).map((item) => <details key={item.id} className="border-t py-2 text-xs"><summary className="cursor-pointer"><b>{item.source_ae}</b> · {item.source_ip} · {item.returned_count} item(ns) · {item.status} · {item.created_at}</summary><pre className="mt-2 overflow-auto rounded bg-slate-950 p-3 text-slate-100">{JSON.stringify({ filtros: item.filters, tagsEnviadas: item.returned_tags }, null, 2)}</pre></details>)}{!catalog.findLogs.length && <div className="text-xs text-slate-500">Nenhuma consulta registrada.</div>}</div>
    </div>}
  </section>;
}
