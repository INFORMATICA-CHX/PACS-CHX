import { useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Download, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { apiFetch } from '@/lib/apiClient';

export interface WorklistCatalog {
  modalities: Array<{ id: number; dicom_code: string; name: string; active: number; required_rules: Record<string, boolean> }>;
  mappings: Array<{ ris_code: string; received_description: string; modality_id: number; modality: string; active: number }>;
  incidents: Array<{ id: number; ris_code: string; sort_order: number; description: string; protocol_code: string; coding_scheme: string; code_meaning: string; body_part: string; view_position: string; laterality: string; observation: string }>;
  unmapped: Array<{ id: number; ris_code: string; received_description: string; status: string; created_at: string }>;
  profiles: Array<{ id: number; name: string; delivery_mode: string; menu_field: string; send_body_part: number; send_view_position: number; charset: string; remove_accents: number; accession_suffix: number; active: number }>;
  equipment: Array<{ id: number; name: string; ae_title: string; ip: string; brand: string; model: string; modality_id: number | null; modality: string; room_unit: string; profile_id: number; profile_name: string; active: number }>;
  findLogs: Array<{ id: number; source_ae: string; source_ip: string; filters: Record<string, string>; returned_count: number; returned_tags: string[]; status: string; created_at: string }>;
}

const blankIncident = { description: '', protocolCode: '', codingScheme: '99PACSCHX', codeMeaning: '', bodyPart: '', viewPosition: '', laterality: '', observation: '' };

export function WorklistMappingAdmin({ api, catalog, onChanged }: { api: string; catalog: WorklistCatalog; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [mapping, setMapping] = useState({ risCode: '', description: '', modalityId: 0, incidents: [{ ...blankIncident }] });
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
    setBusy(true); setMessage('');
    try { await action(); await onChanged(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Falha na operacao.'); }
    finally { setBusy(false); }
  };
  const saveMapping = () => run(async () => {
    if (!mapping.risCode.trim() || !mapping.modalityId || mapping.incidents.some((item) => !item.description.trim())) throw new Error('Informe codigo RIS, modalidade e descricao de cada incidencia.');
    await request('/api/worklist/mappings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mapping) });
    setMapping({ risCode: '', description: '', modalityId: mapping.modalityId, incidents: [{ ...blankIncident }] });
  });
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
      {message && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{message}</div>}
      <div className="flex flex-wrap gap-2">
        <button className="flex items-center gap-2 rounded border px-3 py-2 text-xs" onClick={() => void exportCatalog('json')}><Download size={14}/> Exportar JSON</button>
        <button className="flex items-center gap-2 rounded border px-3 py-2 text-xs" onClick={() => void exportCatalog('csv')}><Download size={14}/> Exportar CSV</button>
        <label className="flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-xs"><Upload size={14}/> Importar JSON<input className="hidden" type="file" accept="application/json,.json" onChange={(event) => importJson(event.target.files?.[0])}/></label>
      </div>

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
        <div className="grid gap-3 md:grid-cols-3"><input className={input} placeholder="Codigo RIS" value={mapping.risCode} onChange={(e) => setMapping((value) => ({ ...value, risCode: e.target.value }))}/><input className={input} placeholder="Descricao recebida" value={mapping.description} onChange={(e) => setMapping((value) => ({ ...value, description: e.target.value }))}/><select className={input} value={mapping.modalityId || ''} onChange={(e) => setMapping((value) => ({ ...value, modalityId: Number(e.target.value) }))}><option value="">Modalidade</option>{catalog.modalities.filter((entry) => entry.active).map((entry) => <option key={entry.id} value={entry.id}>{entry.dicom_code} — {entry.name}</option>)}</select></div>
        {mapping.incidents.map((incident, index) => <div key={index} className="grid gap-2 rounded-lg border bg-slate-50 p-3 md:grid-cols-6">
          <input className={`${input} md:col-span-2`} placeholder="Descricao da incidencia" value={incident.description} onChange={(e) => setMapping((value) => ({ ...value, incidents: value.incidents.map((item, position) => position === index ? { ...item, description: e.target.value } : item) }))}/>
          <input className={input} placeholder="Codigo protocolo" value={incident.protocolCode} onChange={(e) => setMapping((value) => ({ ...value, incidents: value.incidents.map((item, position) => position === index ? { ...item, protocolCode: e.target.value } : item) }))}/>
          <input className={input} placeholder="Body part" value={incident.bodyPart} onChange={(e) => setMapping((value) => ({ ...value, incidents: value.incidents.map((item, position) => position === index ? { ...item, bodyPart: e.target.value.toUpperCase() } : item) }))}/>
          <input className={input} placeholder="View position" value={incident.viewPosition} onChange={(e) => setMapping((value) => ({ ...value, incidents: value.incidents.map((item, position) => position === index ? { ...item, viewPosition: e.target.value.toUpperCase() } : item) }))}/>
          <div className="flex gap-2"><input className={input} placeholder="L/R" maxLength={2} value={incident.laterality} onChange={(e) => setMapping((value) => ({ ...value, incidents: value.incidents.map((item, position) => position === index ? { ...item, laterality: e.target.value.toUpperCase() } : item) }))}/><button title="Excluir incidencia" disabled={mapping.incidents.length === 1} onClick={() => setMapping((value) => ({ ...value, incidents: value.incidents.filter((_, position) => position !== index) }))} className="rounded border border-red-200 p-2 text-red-600 disabled:opacity-30"><Trash2 size={15}/></button></div>
        </div>)}
        <div className="flex justify-between"><button className="flex items-center gap-2 rounded border px-3 py-2 text-xs" onClick={() => setMapping((value) => ({ ...value, incidents: [...value.incidents, { ...blankIncident }] }))}><Plus size={14}/> Outra incidencia</button><button disabled={busy} className="rounded bg-blue-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={() => void saveMapping()}>Salvar mapeamento</button></div>
      </div>

      <div className="overflow-auto rounded-xl border"><table className="w-full text-left text-xs"><thead className="bg-slate-50 uppercase text-slate-500"><tr><th className="p-3">Codigo RIS</th><th>Modalidade</th><th>Incidencias</th><th className="pr-3 text-right">Acoes</th></tr></thead><tbody>{catalog.mappings.map((entry) => <tr key={entry.ris_code} className="border-t align-top"><td className="p-3"><b>{entry.ris_code}</b><div className="text-slate-500">{entry.received_description}</div></td><td className="pt-3">{entry.modality}</td><td className="py-2">{catalog.incidents.filter((incident) => incident.ris_code === entry.ris_code).map((incident) => <div key={incident.id} className="mb-1 flex items-center justify-between rounded border bg-slate-50 px-2 py-1"><span><b>{incident.sort_order}. {incident.description}</b> <span className="text-slate-500">{incident.body_part} {incident.view_position} {incident.laterality}</span></span><span className="ml-2 flex gap-1"><button title="Subir" onClick={() => void moveIncident(incident, -1)}><ArrowUp size={13}/></button><button title="Descer" onClick={() => void moveIncident(incident, 1)}><ArrowDown size={13}/></button><button title="Editar" onClick={() => editIncident(incident)}><Pencil size={13}/></button><button title="Excluir incidencia" className="text-red-600" onClick={() => { if (window.confirm(`Excluir incidencia ${incident.description}?`)) void run(async () => { await request(`/api/worklist/incidents/${incident.id}`, { method: 'DELETE' }); }); }}><Trash2 size={13}/></button></span></div>) || 'Sem incidencia'}</td><td className="pr-3 pt-2 text-right"><button title="Duplicar" className="mr-2 rounded border p-2" onClick={() => { const code = window.prompt('Novo codigo RIS:'); if (code) void run(async () => { await request(`/api/worklist/mappings/${encodeURIComponent(entry.ris_code)}/duplicate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ risCode: code }) }); }); }}><Copy size={14}/></button><button title="Excluir" className="rounded border border-red-200 p-2 text-red-600" onClick={() => { if (window.confirm(`Excluir ${entry.ris_code}?`)) void run(async () => { await request(`/api/worklist/mappings/${encodeURIComponent(entry.ris_code)}`, { method: 'DELETE' }); }); }}><Trash2 size={14}/></button></td></tr>)}</tbody></table></div>

      {catalog.unmapped.length > 0 && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><div className="mb-2 text-xs font-semibold uppercase text-amber-800">Fila de codigos nao mapeados</div>{catalog.unmapped.map((item) => <div key={item.id} className="flex justify-between border-t border-amber-200 py-2 text-sm"><span><b>{item.ris_code}</b> — {item.received_description || 'Sem descricao'}</span><span className="text-xs uppercase text-amber-700">{item.status}</span></div>)}</div>}
      <div className="rounded-xl border p-4"><div className="mb-2 text-xs font-semibold uppercase text-slate-500">Ultimas consultas C-FIND por equipamento</div>{catalog.findLogs.slice(0, 20).map((item) => <details key={item.id} className="border-t py-2 text-xs"><summary className="cursor-pointer"><b>{item.source_ae}</b> · {item.source_ip} · {item.returned_count} item(ns) · {item.status} · {item.created_at}</summary><pre className="mt-2 overflow-auto rounded bg-slate-950 p-3 text-slate-100">{JSON.stringify({ filtros: item.filters, tagsEnviadas: item.returned_tags }, null, 2)}</pre></details>)}{!catalog.findLogs.length && <div className="text-xs text-slate-500">Nenhuma consulta registrada.</div>}</div>
    </div>}
  </section>;
}
