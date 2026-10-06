import { useCallback, useEffect, useState } from 'react';
import { Activity, CheckCircle2, Clock3, DatabaseZap, KeyRound, LockKeyhole, Plus, RefreshCw, Save, ShieldCheck, Trash2, UserRoundCog, UsersRound, XCircle } from 'lucide-react';

interface Props { api: string; token: string; busy: string; runMaintenance: (action: string, label: string) => Promise<void>; addLog: (level: 'info' | 'success' | 'warning' | 'error', message: string, source: string) => void }
interface UserRow { id: number; username: string; display_name: string; role: Role; active: number; must_change_password: number; created_at: string; updated_at: string; locked_until?: string | null }
interface AuditRow { id: number; timestamp: string; actor: string; role: string; action: string; resource: string; details?: string }
type Role = 'master' | 'admin' | 'radiologist' | 'technician' | 'reception' | 'printing' | 'maintenance' | 'auditor' | 'viewer';
type Section = 'tools' | 'users' | 'audit';
interface MaintenanceResult { action: string; ok: boolean; message: string; durationMs: number; at: string }
const roles: { value: Role; label: string; description: string }[] = [
  { value: 'master', label: 'Master', description: 'Acesso total ao sistema para o proprietário' },
  { value: 'admin', label: 'Administrador', description: 'Acesso administrativo completo' },
  { value: 'radiologist', label: 'Médico / Radiologista', description: 'Visualiza, edita e assina laudos e gerencia modelos' },
  { value: 'technician', label: 'Técnico', description: 'Opera exames e imagens' },
  { value: 'reception', label: 'Recepção', description: 'Cadastro e Worklist' },
  { value: 'printing', label: 'Impressão', description: 'Central e filas de impressão' },
  { value: 'maintenance', label: 'Manutenção', description: 'Diagnóstico e suporte' },
  { value: 'auditor', label: 'Auditor', description: 'Consulta trilhas de auditoria' },
  { value: 'viewer', label: 'Visualizador', description: 'Somente leitura de exames' },
];

export function MaintenanceConsole({ api, token, busy, addLog }: Props) {
  const [section, setSection] = useState<Section>('tools');
  const [users, setUsers] = useState<UserRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [selected, setSelected] = useState<UserRow>();
  const [form, setForm] = useState({ username: '', displayName: '', password: '', role: 'viewer' as Role });
  const [resetPassword, setResetPassword] = useState('');
  const [working, setWorking] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [pendingMaintenance, setPendingMaintenance] = useState<{ action: string; label: string }>();
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string }>();
  const [auditValid, setAuditValid] = useState<boolean>();
  const [maintenanceResult, setMaintenanceResult] = useState<MaintenanceResult>();
  const [maintenanceAction, setMaintenanceAction] = useState('');
  const request = useCallback(async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${api}${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'X-Service-Token': token, ...init.headers } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Operao recusada');
    return result;
  }, [api, token]);
  const loadUsers = useCallback(async () => { try { setUsers(await request('/api/service/users')); } catch (error) { addLog('error', message(error), 'SECURITY'); } }, [request, addLog]);
  const loadAudit = useCallback(async () => { try { const [rows, integrity] = await Promise.all([request('/api/service/audit'), request('/api/service/audit/verify')]); setAudit(rows); setAuditValid(Boolean(integrity.valid)); } catch (error) { addLog('error', message(error), 'AUDIT'); } }, [request, addLog]);
  useEffect(() => { if (section === 'users') void loadUsers(); if (section === 'audit') void loadAudit(); }, [section, loadUsers, loadAudit]);

  const create = async () => { setWorking(true); try { await request('/api/service/users', { method: 'POST', body: JSON.stringify(form) }); setForm({ username: '', displayName: '', password: '', role: 'viewer' }); await loadUsers(); addLog('success', 'Usuário criado com troca de senha obrigatria', 'SECURITY'); } catch (error) { addLog('error', message(error), 'SECURITY'); } finally { setWorking(false); } };
  const save = async () => {
    if (!selected) return;
    setWorking(true);
    setNotice(undefined);
    try {
      const result = await request(`/api/service/users/${selected.id}`, { method: 'PUT', body: JSON.stringify({ displayName: selected.display_name, role: selected.role, active: Boolean(selected.active), mustChangePassword: Boolean(selected.must_change_password) }) });
      await loadUsers();
      if (result.user) setSelected(result.user);
      const text = `Permissoes de @${selected.username} salvas com sucesso.`;
      setNotice({ kind: 'success', text });
      addLog('success', text, 'SECURITY');
    } catch (error) {
      const text = message(error);
      setNotice({ kind: 'error', text });
      addLog('error', text, 'SECURITY');
    } finally {
      setWorking(false);
    }
  };
  const reset = async () => { if (!selected) return; setWorking(true); try { await request(`/api/service/users/${selected.id}/password`, { method: 'POST', body: JSON.stringify({ password: resetPassword, mustChange: false }) }); setResetPassword(''); addLog('success', `Nova senha definida para ${selected.username}`, 'SECURITY'); } catch (error) { addLog('error', message(error), 'SECURITY'); } finally { setWorking(false); } };
  const unlock = async () => { if (!selected) return; setWorking(true); try { await request(`/api/service/users/${selected.id}/unlock`, { method: 'POST', body: '{}' }); await loadUsers(); addLog('success', `Conta ${selected.username} desbloqueada`, 'SECURITY'); } catch (error) { addLog('error', message(error), 'SECURITY'); } finally { setWorking(false); } };
  const remove = async () => {
    if (!selected) return;
    setWorking(true);
    setNotice(undefined);
    try {
      await request(`/api/service/users/${selected.id}`, { method: 'DELETE' });
      const text = `Usuário @${selected.username} excluído.`;
      addLog('warning', text, 'SECURITY');
      setNotice({ kind: 'success', text });
      setPendingDelete(false);
      setSelected(undefined);
      await loadUsers();
    } catch (error) {
      const text = message(error);
      setNotice({ kind: 'error', text });
      addLog('error', text, 'SECURITY');
    } finally {
      setWorking(false);
    }
  };
  const executeMaintenance = (action: string, label: string) => {
    if (action === 'vacuum' || action === 'reindex') { setPendingMaintenance({ action, label }); return; }
    void performMaintenance(action, label);
  };
  const performMaintenance = async (action: string, label: string) => {
    setPendingMaintenance(undefined);
    setMaintenanceAction(action);
    try {
      const result = await request('/api/database/maintenance', { method: 'POST', body: JSON.stringify({ action }) });
      setMaintenanceResult({ action, ok: Boolean(result.ok), message: String(result.message ?? `${label} concludo.`), durationMs: Number(result.durationMs ?? 0), at: new Date().toISOString() });
      addLog(result.ok ? 'success' : 'warning', String(result.message ?? label), 'DATABASE');
    } catch (error) {
      setMaintenanceResult({ action, ok: false, message: message(error), durationMs: 0, at: new Date().toISOString() });
      addLog('error', message(error), 'DATABASE');
    } finally { setMaintenanceAction(''); }
  };

  return <div className="space-y-4">
    {notice && <div className={`rounded-xl border px-4 py-3 text-sm ${notice.kind === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'}`}>{notice.text}</div>}
    <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-white p-2">
      <Nav active={section === 'tools'} onClick={() => setSection('tools')} icon={<Activity size={16}/>} label="Ferramentas"/>
      <Nav active={section === 'users'} onClick={() => setSection('users')} icon={<UsersRound size={16}/>} label="Usuários e permissões"/>
      <Nav active={section === 'audit'} onClick={() => setSection('audit')} icon={<ShieldCheck size={16}/>} label="Auditoria"/>
      <span className="ml-auto flex items-center gap-2 px-3 text-xs font-medium text-emerald-700"><LockKeyhole size={14}/> Sesso de servio protegida</span>
    </div>
    {section === 'tools' && <section className="rounded-xl border bg-white"><Title icon={<Activity size={16}/>} text="Manutenção SQLite"/><div className="p-5"><div className="mb-4 rounded-xl border border-blue-100 bg-blue-50/60 p-4 text-sm text-blue-900"><b>Manutenção segura do banco local</b><p className="mt-1 text-xs text-blue-700">Execute a verificao de integridade regularmente. Compactao e reconstruo de índices podem ocupar o banco por alguns instantes.</p></div>{pendingMaintenance && <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><b className="mr-auto">{pendingMaintenance.label}? Durante alguns instantes o banco pode ficar ocupado.</b><button onClick={() => void performMaintenance(pendingMaintenance.action, pendingMaintenance.label)} className="rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700">Confirmar</button><button onClick={() => setPendingMaintenance(undefined)} className="rounded-lg border border-amber-300 px-4 py-2 text-xs font-semibold text-amber-800">Cancelar</button></div>}<div className="grid gap-3 md:grid-cols-2">{[
      ['integrity','Verificar integridade','Procura corrupção e inconsistências','Recomendado semanalmente'],
      ['vacuum','Compactar banco','Recupera espaço e reorganiza o arquivo','Execute fora do horário de pico'],
      ['reindex','Reconstruir índices','Recria os índices de pesquisa','Use se as consultas ficarem lentas'],
      ['analyze','Atualizar estatísticas','Otimiza o plano de consultas SQLite','Seguro para manutenção periódica'],
    ].map(([action,label,description,recommendation]) => <button key={action} disabled={Boolean(maintenanceAction || busy)} onClick={() => void executeMaintenance(action, label)} className="group rounded-xl border bg-slate-50 p-4 text-left transition hover:border-blue-400 hover:bg-blue-50 disabled:cursor-wait disabled:opacity-50"><div className="flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-blue-600 shadow-sm"><DatabaseZap size={17}/></span><span><b className="block text-sm text-slate-800">{maintenanceAction === action ? 'Executando...' : label}</b><span className="mt-1 block text-xs text-slate-500">{description}</span><span className="mt-2 block text-[10px] font-semibold uppercase tracking-wide text-blue-600">{recommendation}</span></span></div></button>)}</div>{maintenanceResult && <div className={`mt-4 flex items-center gap-3 rounded-xl border p-4 ${maintenanceResult.ok ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}>{maintenanceResult.ok ? <CheckCircle2 className="text-emerald-600"/> : <XCircle className="text-rose-600"/>}<div><b className={maintenanceResult.ok ? 'text-emerald-800' : 'text-rose-800'}>{maintenanceResult.message}</b><div className="mt-1 flex gap-4 text-xs text-slate-500"><span className="flex items-center gap-1"><Clock3 size={12}/>{new Date(maintenanceResult.at).toLocaleString('pt-BR')}</span><span>Duração: {formatDuration(maintenanceResult.durationMs)}</span></div></div></div>}</div></section>}
    {section === 'users' && <div className="grid gap-4 xl:grid-cols-[1.15fr_.85fr]">
      <section className="overflow-hidden rounded-xl border bg-white"><Title icon={<UsersRound size={16}/>} text={`Usuários cadastrados (${users.length})`} action={<button onClick={() => void loadUsers()} className="rounded-lg border p-2 text-slate-500 hover:text-blue-600"><RefreshCw size={14}/></button>}/><div className="max-h-[480px] overflow-auto"><table className="w-full text-left text-sm"><thead className="sticky top-0 bg-slate-50 text-[11px] uppercase text-slate-500"><tr><th className="px-4 py-3">Usuário</th><th>Perfil</th><th>Status</th><th></th></tr></thead><tbody>{users.map((user) => <tr key={user.id} className={`border-t hover:bg-blue-50/60 ${selected?.id === user.id ? 'bg-blue-50' : ''}`}><td className="px-4 py-3"><b className="block text-slate-800">{user.display_name}</b><span className="text-xs text-slate-500">@{user.username}</span></td><td><span className="rounded-full bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">{roleLabel(user.role)}</span></td><td><span className={`text-xs font-semibold ${user.active ? 'text-emerald-600' : 'text-rose-600'}`}>{user.active ? 'Ativo' : 'Desativado'}</span></td><td className="pr-3 text-right"><button onClick={() => { setSelected({ ...user }); setResetPassword(''); setPendingDelete(false); setNotice(undefined); }} className="rounded-lg border px-3 py-1.5 text-xs font-semibold text-blue-700">Gerenciar</button></td></tr>)}</tbody></table></div></section>
      <div className="space-y-4">{selected ? <section className="rounded-xl border bg-white"><Title icon={<UserRoundCog size={16}/>} text={`Gerenciar @${selected.username}`}/><div className="space-y-3 p-4"><Field label="Nome completo"><input value={selected.display_name} onChange={(e) => setSelected({ ...selected, display_name: e.target.value })}/></Field><Field label="Perfil de permissão"><select value={selected.role} onChange={(e) => setSelected({ ...selected, role: e.target.value as Role })}>{roles.map((role) => <option key={role.value} value={role.value}>{role.label} - {role.description}</option>)}</select></Field><label className="flex items-center justify-between rounded-lg border p-3 text-sm"><span><b className="block">Conta ativa</b><span className="text-xs text-slate-500">Permite autenticação no sistema</span></span><input type="checkbox" checked={Boolean(selected.active)} onChange={(e) => setSelected({ ...selected, active: e.target.checked ? 1 : 0 })}/></label><button disabled={working} onClick={() => void save()} className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white"><Save size={15}/>{working ? 'Salvando...' : 'Salvar permissões'}</button><div className="border-t pt-3"><Field label="Nova senha temporária"><input type="password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} placeholder="Mínimo de 10 caracteres"/></Field><div className="mt-2 grid grid-cols-2 gap-2"><button disabled={working || resetPassword.length < 10} onClick={() => void reset()} className="flex items-center justify-center gap-1 rounded-lg border py-2 text-xs font-semibold text-blue-700 disabled:opacity-40"><KeyRound size={14}/> Redefinir senha</button><button disabled={working} onClick={() => void unlock()} className="flex items-center justify-center gap-1 rounded-lg border py-2 text-xs font-semibold text-amber-700"><LockKeyhole size={14}/> Desbloquear</button></div></div></div></section> : <CreateUser form={form} setForm={setForm} working={working} create={create}/>}</div>
      {selected && <section className="rounded-xl border border-rose-200 bg-white xl:col-start-2"><Title icon={<Trash2 size={16}/>} text="Excluir usuário"/><div className="p-4">{pendingDelete ? <div className="space-y-2"><p className="text-sm font-semibold text-rose-700">Excluir definitivamente @{selected.username}? Esta ação não pode ser desfeita.</p><div className="grid grid-cols-2 gap-2"><button disabled={working} onClick={() => void remove()} className="flex items-center justify-center gap-2 rounded-lg bg-rose-600 py-2.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-40"><Trash2 size={15}/>{working ? 'Excluindo...' : 'Confirmar exclusão'}</button><button disabled={working} onClick={() => setPendingDelete(false)} className="rounded-lg border py-2.5 text-sm font-semibold text-slate-600 disabled:opacity-40">Cancelar</button></div></div> : <button disabled={working} onClick={() => { setNotice(undefined); setPendingDelete(true); }} className="flex w-full items-center justify-center gap-2 rounded-lg bg-rose-600 py-2.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-40"><Trash2 size={15}/> Excluir @{selected.username}</button>}<p className="mt-2 text-[11px] leading-4 text-slate-500">Remove o login local do PACS.</p></div></section>}
    </div>}
    {section === 'audit' && <section className="overflow-hidden rounded-xl border bg-white"><Title icon={<ShieldCheck size={16}/>} text="Trilha de auditoria" action={<div className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold ${auditValid ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}><CheckCircle2 size={13}/>{auditValid ? 'Cadeia íntegra' : 'Verificação pendente'}</div>}/><div className="max-h-[500px] overflow-auto"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-slate-50 uppercase text-slate-500"><tr><th className="px-4 py-3">Data/hora</th><th>Responsável</th><th>Ação</th><th>Recurso</th></tr></thead><tbody>{audit.map((row) => <tr key={row.id} className="border-t"><td className="whitespace-nowrap px-4 py-3">{new Date(row.timestamp).toLocaleString('pt-BR')}</td><td><b>{row.actor}</b><span className="ml-1 text-slate-400">{row.role}</span></td><td className="font-mono text-blue-700">{row.action}</td><td className="font-mono text-slate-500">{row.resource}</td></tr>)}</tbody></table></div></section>}
  </div>;
}

function CreateUser({ form, setForm, working, create }: { form: { username: string; displayName: string; password: string; role: Role }; setForm: React.Dispatch<React.SetStateAction<{ username: string; displayName: string; password: string; role: Role }>>; working: boolean; create: () => Promise<void> }) { return <section className="rounded-xl border bg-white"><Title icon={<Plus size={16}/>} text="Novo usurio"/><div className="space-y-3 p-4"><Field label="Nome completo"><input value={form.displayName} onChange={(e) => setForm((v) => ({ ...v, displayName: e.target.value }))}/></Field><Field label="Nome de acesso"><input value={form.username} onChange={(e) => setForm((v) => ({ ...v, username: e.target.value }))} placeholder="ex.: maria.silva"/></Field><Field label="Senha"><input type="password" value={form.password} onChange={(e) => setForm((v) => ({ ...v, password: e.target.value }))} placeholder="Mínimo de 10 caracteres"/></Field><Field label="Perfil"><select value={form.role} onChange={(e) => setForm((v) => ({ ...v, role: e.target.value as Role }))}>{roles.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select></Field><button disabled={working || !form.displayName || form.username.length < 3 || form.password.length < 10} onClick={() => void create()} className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white disabled:opacity-40"><Plus size={15}/> Criar usurio</button></div></section>; }
function Nav({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) { return <button onClick={onClick} className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold ${active ? 'bg-blue-600 text-white shadow' : 'text-slate-600 hover:bg-slate-100'}`}>{icon}{label}</button>; }
function Title({ icon, text, action }: { icon: React.ReactNode; text: string; action?: React.ReactNode }) { return <div className="flex min-h-12 items-center gap-2 border-b px-4 text-xs font-semibold uppercase text-slate-500">{icon}{text}<div className="ml-auto">{action}</div></div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-xs font-semibold text-slate-600">{label}<span className="mt-1 block [&_input]:w-full [&_input]:rounded-lg [&_input]:border [&_input]:px-3 [&_input]:py-2.5 [&_select]:w-full [&_select]:rounded-lg [&_select]:border [&_select]:bg-white [&_select]:px-3 [&_select]:py-2.5">{children}</span></label>; }
function roleLabel(role: Role) { return roles.find((item) => item.value === role)?.label ?? role; }
function message(error: unknown) { return error instanceof Error ? error.message : 'Operao no concluda'; }
function formatDuration(ms: number) { return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`; }


