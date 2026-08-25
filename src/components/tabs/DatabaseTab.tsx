import { useCallback, useEffect, useState } from 'react';
import { Archive, Database, FolderOpen, HardDrive, ShieldAlert } from 'lucide-react';
import type { PacsStore } from '@/lib/usePacsStore';
import { ServiceLogin } from '@/components/ServiceLogin';
import { MaintenanceConsole } from '@/components/MaintenanceConsole';

interface Stats { patientCount: number; studyCount: number; seriesCount: number; instanceCount: number; storageBytes: number; databaseBytes: number }
type Tab = 'storage' | 'backup' | 'delete' | 'maintenance';

export function DatabaseTab({ store }: { store: PacsStore }) {
  const { config, addLog } = store;
  const [tab, setTab] = useState<Tab>('storage');
  const [stats, setStats] = useState<Stats>();
  const [busy, setBusy] = useState('');
  const [backupPath, setBackupPath] = useState('');
  const [patientId, setPatientId] = useState('');
  const [days, setDays] = useState(365);
  const [maintenanceToken, setMaintenanceToken] = useState('');
  const api = `http://127.0.0.1:${config.apiPort}`;

  const refresh = useCallback(async () => {
    try { const response = await fetch(`${api}/api/stats`); if (response.ok) setStats(await response.json()); }
    catch { addLog('error', 'Nao foi possivel consultar o banco', 'DATABASE'); }
  }, [api, addLog]);
  useEffect(() => { void refresh(); }, [refresh]);

  const post = async (path: string, body: unknown, label: string) => {
    setBusy(label);
    try { const response = await fetch(`${api}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(maintenanceToken ? { 'X-Service-Token': maintenanceToken } : {}) }, body: JSON.stringify(body) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); addLog('success', `${label} concluido${result.path ? `: ${result.path}` : ''}`, 'DATABASE'); await refresh(); }
    catch (error) { addLog('error', error instanceof Error ? error.message : `Falha em ${label}`, 'DATABASE'); }
    finally { setBusy(''); }
  };
  const remove = async (path: string, label: string) => {
    setBusy(label);
    try { const response = await fetch(`${api}${path}`, { method: 'DELETE', headers: maintenanceToken ? { 'X-Service-Token': maintenanceToken } : {} }); const result = await response.json(); if (!response.ok) throw new Error(result.error); addLog('warning', `${label}: ${result.deletedStudies} estudo(s) excluido(s)`, 'DATABASE'); await refresh(); }
    catch (error) { addLog('error', error instanceof Error ? error.message : `Falha em ${label}`, 'DATABASE'); }
    finally { setBusy(''); }
  };
  const chooseBackup = async () => { const folder = await window.localPacs?.openFolder(); if (folder) setBackupPath(folder); };
  const formatSize = (bytes = 0) => bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;

  const tabs: { id: Tab; label: string }[] = [{ id: 'storage', label: 'Armazenamento' }, { id: 'backup', label: 'Backup' }, { id: 'delete', label: 'Exclusão' }, { id: 'maintenance', label: 'Manutenção' }];
  return <div className="relative space-y-4 p-5"><div className="flex gap-1 border-b border-slate-200">{tabs.map((item) => <button key={item.id} onClick={() => { if (item.id === 'maintenance') setMaintenanceToken(''); setTab(item.id); }} className={`border-b-2 px-4 py-2 text-sm ${tab === item.id ? 'border-blue-600 font-semibold text-blue-700' : 'border-transparent text-slate-500'}`}>{item.label}</button>)}</div>
    {tab === 'maintenance' && !maintenanceToken && <div className="absolute inset-x-5 bottom-5 top-[61px] z-20 rounded-xl bg-[#f3f7fc]"><ServiceLogin api={api} onAuthorized={setMaintenanceToken} addLog={addLog}/></div>}
    {tab === 'storage' && <section><Header icon={<Database size={15}/>} title="Banco PACS em tempo real"/><div className="grid gap-3 p-5 md:grid-cols-3"><Stat label="Pacientes" value={stats?.patientCount}/><Stat label="Estudos" value={stats?.studyCount}/><Stat label="Séries" value={stats?.seriesCount}/><Stat label="Imagens DICOM" value={stats?.instanceCount}/><Stat label="Armazenamento" value={formatSize(stats?.storageBytes)}/><Stat label="Tamanho do banco" value={formatSize(stats?.databaseBytes)}/></div><div className="border-t px-5 py-3 text-xs text-slate-500"><HardDrive size={13} className="mr-2 inline"/>{config.storagePath}</div></section>}
    {tab === 'backup' && <section><Header icon={<Archive size={15}/>} title="Backup manual do SQLite"/><div className="space-y-3 p-5"><p className="text-sm text-slate-600">Cria uma cópia consistente do banco após executar o checkpoint do WAL.</p><div className="flex gap-2"><input className="flex-1 border px-3 py-2 text-sm" value={backupPath} readOnly placeholder="Selecione a pasta de destino"/><button onClick={() => void chooseBackup()} className="flex items-center gap-2 border px-4 text-sm"><FolderOpen size={15}/> Procurar</button><button disabled={!backupPath || !!busy} onClick={() => void post('/api/database/backup', { destination: backupPath }, 'Backup')} className="bg-blue-600 px-5 text-sm font-semibold text-white disabled:opacity-40">Criar backup</button></div></div></section>}
    {tab === 'delete' && <section><Header icon={<ShieldAlert size={15}/>} title="Exclusão definitiva"/><div className="space-y-5 p-5"><div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">Os metadados e arquivos DICOM serão removidos permanentemente.</div><div><label className="text-sm font-medium">Patient ID</label><div className="mt-1 flex gap-2"><input className="flex-1 border px-3 py-2" value={patientId} onChange={(e) => setPatientId(e.target.value)}/><button disabled={!patientId || !!busy} onClick={() => confirm(`Excluir permanentemente o paciente ${patientId}?`) && void remove(`/api/database/patient/${encodeURIComponent(patientId)}`, 'Excluir paciente')} className="border border-red-300 bg-red-50 px-4 text-sm text-red-700 disabled:opacity-40">Excluir paciente</button></div></div><div><label className="text-sm font-medium">Estudos anteriores a</label><div className="mt-1 flex items-center gap-2"><input className="w-28 border px-3 py-2" type="number" value={days} onChange={(e) => setDays(Number(e.target.value))}/><span className="text-sm text-slate-500">dias</span><button disabled={days < 1 || !!busy} onClick={() => confirm(`Excluir permanentemente estudos com mais de ${days} dias?`) && void remove(`/api/database/studies?olderThanDays=${days}`, 'Excluir antigos')} className="ml-auto border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700 disabled:opacity-40">Excluir estudos antigos</button></div></div></div></section>}
    {tab === 'maintenance' && maintenanceToken && <MaintenanceConsole api={api} token={maintenanceToken} busy={busy} runMaintenance={(action, label) => post('/api/database/maintenance', { action }, label)} addLog={addLog}/>}
  </div>;
}
function Header({ icon, title }: { icon: React.ReactNode; title: string }) { return <div className="flex items-center gap-2 border-b px-4 py-3 text-xs font-semibold uppercase text-slate-500">{icon}{title}</div>; }
function Stat({ label, value }: { label: string; value: string | number | undefined }) { return <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-4"><div className="text-xs text-slate-500">{label}</div><div className="mt-1 text-2xl font-bold text-slate-800">{value ?? '—'}</div></div>; }
