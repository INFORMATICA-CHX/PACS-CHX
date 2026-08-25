import { useRef, useState, useEffect, lazy, Suspense } from 'react';
import { X, Shield, ChevronDown, List, Activity, Settings as SettingsIcon, User, Eye, EyeOff, Database, Server, LockKeyhole, LogOut, ClipboardList } from 'lucide-react';
import { usePacsStore } from '@/lib/usePacsStore';
import type { Study } from '@/types';
import { apiFetch, getClinicalToken, sessionFragment, setClinicalToken } from '@/lib/apiClient';
import './index.css';

const Worklist = lazy(() => import('@/components/Worklist').then((m) => ({ default: m.Worklist })));
const Viewer = lazy(() => import('@/components/Viewer').then((m) => ({ default: m.Viewer })));
const Status = lazy(() => import('@/components/Status').then((m) => ({ default: m.Status })));
const Settings = lazy(() => import('@/components/Settings').then((m) => ({ default: m.Settings })));
const PrintCenter = lazy(() => import('@/components/PrintCenter').then((m) => ({ default: m.PrintCenter })));
const TotpSetup = lazy(() => import('@/components/TotpSetup').then((m) => ({ default: m.TotpSetup })));
const WorklistTab = lazy(() => import('@/components/tabs/WorklistTab').then((m) => ({ default: m.WorklistTab })));

const suspenseFallback = (
  <div className="flex h-full items-center justify-center bg-slate-950 text-sm text-blue-100">
    <div className="text-center">
      <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-2 border-blue-300/20 border-t-cyan-300" />
      <div className="font-semibold">Carregando...</div>
    </div>
  </div>
);

type TabKind = 'worklist' | 'worklistSchedule' | 'viewer' | 'status' | 'settings';
interface Tab { id: string; kind: TabKind; label: string; study?: Study; }

function dicomDate(value: string) {
  const digits = value.replace(/[^0-9]/g, '');
  return digits.length >= 8 ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` : value;
}

function dicomTime(value: string) {
  const digits = value.replace(/[^0-9]/g, '');
  return digits.length >= 4 ? `${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4, 6) || '00'}` : value;
}

function mapStudy(row: Record<string, unknown>): Study {
  return {
    id: String(row.id), patientId: String(row.patient_id ?? ''), patientName: String(row.patient_name ?? ''),
    patientBirthDate: dicomDate(String(row.birth_date ?? '')), patientSex: String(row.sex ?? '') as Study['patientSex'],
    studyDate: dicomDate(String(row.study_date ?? '')), studyTime: dicomTime(String(row.study_time ?? '')),
    accessionNumber: String(row.accession_number ?? ''), modality: String(row.modality ?? ''),
    studyDescription: String(row.study_description ?? ''), bodyPartExamined: String(row.body_part_examined ?? ''),
    seriesCount: Number(row.series_count ?? 0), imageCount: Number(row.image_count ?? 0),
    sourceAeTitle: String(row.source_ae_title ?? ''), institution: String(row.institution_name ?? ''),
    referringPhysician: String(row.referring_physician ?? ''), updatedAt: String(row.received_at ?? ''),
  };
}

export default function ViewerApp() {
  const handoffToken = new URLSearchParams(window.location.hash.slice(1)).get('access');
  if (handoffToken) { setClinicalToken(handoffToken); window.history.replaceState({}, '', window.location.pathname + window.location.search); }
  const store = usePacsStore();
  const refreshData = store.refreshData;
  const setStoreConfig = store.setConfig;
  const initialConfig = useRef(store.config);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [userRole, setUserRole] = useState('viewer');
  const [displayName, setDisplayName] = useState('');
  const [loginUser, setLoginUser] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState(() => { const message = sessionStorage.getItem('pacs_logout_message') ?? ''; sessionStorage.removeItem('pacs_logout_message'); return message; });
  const [mfaCode, setMfaCode] = useState('');
  const [preAuthToken, setPreAuthToken] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([
    { id: 'worklist', kind: 'worklist', label: 'Lista' },
    { id: 'worklistSchedule', kind: 'worklistSchedule', label: 'Cadastro Worklist' },
  ]);
  const [directStudy, setDirectStudy] = useState<Study | null>(null);
  const [directStudyError, setDirectStudyError] = useState('');
  const [activeTabId, setActiveTabId] = useState('worklist');
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const adminRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (adminRef.current && !adminRef.current.contains(event.target as Node)) setAdminMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  useEffect(() => {
    if (!getClinicalToken()) return;
    apiFetch('/api/auth/session').then(async (response) => {
      if (!response.ok) { setClinicalToken(null); return; }
      const session = await response.json();
      setAuthenticated(true); setUserRole(session.role); setDisplayName(session.displayName || session.user);
      await refreshData();
    }).catch(() => undefined);
  }, [refreshData]);

  useEffect(() => {
    fetch('/api/config')
      .then((response) => {
        if (!response.ok) throw new Error('Config unavailable');
        return response.json();
      })
      .then((config) => setStoreConfig({ ...initialConfig.current, ...config }))
      .finally(() => setConfigLoaded(true));
  }, [setStoreConfig]);

  const openStudy = (study: Study) => {
    const url = new URL('/viewer', window.location.origin);
    url.searchParams.set('study', study.id);
    url.hash = sessionFragment();
    window.open(url.toString(), `pacs-study-${study.id}`);
  };
  const addSystemTab = (kind: Extract<TabKind, 'status' | 'settings'>, label: string) => {
    const existing = tabs.find((tab) => tab.kind === kind);
    if (existing) return setActiveTabId(existing.id);
    const id = `${kind}_${Date.now()}`;
    setTabs((current) => [...current, { id, kind, label }]);
    setActiveTabId(id);
  };
  const closeTab = (id: string) => {
    setTabs((current) => current.filter((tab) => tab.id !== id));
    if (activeTabId === id) setActiveTabId('worklist');
  };
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const directStudyId = new URLSearchParams(window.location.search).get('study');

  useEffect(() => {
    if (!directStudyId || directStudy || directStudyError) return;
    apiFetch(`/api/studies/${directStudyId}`)
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error ?? 'Estudo nao encontrado.');
        setDirectStudy(mapStudy(payload));
      })
      .catch((error) => setDirectStudyError(error instanceof Error ? error.message : 'Falha ao carregar estudo.'));
  }, [directStudyId, directStudy, directStudyError]);

  const submitLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    const user = loginUser.trim();
    try {
      const response = await fetch(preAuthToken ? '/api/auth/totp/verify' : '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preAuthToken ? { preAuthToken, code: mfaCode } : { user, password: loginPassword }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Falha de autenticação.');
      if (result.mfaRequired) { setPreAuthToken(result.preAuthToken); setLoginError(''); return; }
      setClinicalToken(result.token);
      setAuthenticated(true);
      setUserRole(result.role);
      setDisplayName(result.displayName || result.user);
      setLoginError('');
      setPreAuthToken(''); setMfaCode('');
      store.addLog('success', `Login do Viewer realizado por ${user}`, 'AUTH');
      await refreshData();
      return;
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Usuário ou senha inválidos.');
      store.addLog('warning', `Falha de login no Viewer para ${user || '(vazio)'}`, 'AUTH');
    }
  };

  const requestedModule = new URLSearchParams(window.location.search).get('module');
  const printMode = new URLSearchParams(window.location.search).get('printMode') === 'dicom' ? 'dicom' : 'paper';
  if (requestedModule === 'printing') return <Suspense fallback={suspenseFallback}><PrintCenter store={store} mode={printMode} /></Suspense>;
  if (directStudyId) {
    const study = directStudy ?? store.studies.find((item) => item.id === directStudyId);
    if (study) return <Suspense fallback={suspenseFallback}><Viewer key={study.id} study={study} allSeries={store.series} /></Suspense>;
    return <div className="flex h-full items-center justify-center bg-slate-950 text-sm text-blue-100"><div className="text-center"><div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-2 border-blue-300/20 border-t-cyan-300" /><div className="font-semibold">Carregando estudo DICOM</div><div className="mt-1 text-xs text-slate-500">Preparando séries e imagens...</div></div></div>;
  }

  if (!authenticated) {
    return (
      <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-[#edf4fb] p-4 text-slate-900">
        <div className="absolute -left-32 -top-32 h-[34rem] w-[34rem] rounded-full bg-blue-300/30 blur-3xl" />
        <div className="absolute -bottom-48 right-0 h-[40rem] w-[40rem] rounded-full bg-cyan-200/40 blur-3xl" />
        <div className="relative grid w-full max-w-5xl overflow-hidden rounded-[28px] border border-white/80 bg-white shadow-[0_30px_90px_rgba(8,47,101,.22)] lg:grid-cols-[1.1fr_.9fr]">
          <aside className="relative hidden min-h-[620px] overflow-hidden bg-gradient-to-br from-blue-950 via-blue-800 to-blue-600 p-12 text-white lg:flex lg:flex-col">
            <div className="absolute -right-24 top-16 h-72 w-72 rounded-full border-[48px] border-white/5" />
            <div className="relative flex items-center gap-3"><div className="h-14 w-14 rounded-2xl border border-white/20 bg-white/10 p-2.5"><img src="./brand/pacs-chx-logo.png" alt="PACS CHX" className="h-full w-full object-contain" /></div><div><div className="text-xl font-bold">PACS CHX</div><div className="text-xs uppercase tracking-[.24em] text-blue-200">Clinical Imaging</div></div></div>
            <div className="relative my-auto max-w-md"><span className="rounded-full border border-cyan-200/20 bg-cyan-300/10 px-3 py-1 text-xs font-semibold text-cyan-100">Estação diagnóstica integrada</span><h2 className="mt-6 text-4xl font-semibold leading-tight">Seus exames.<br />Uma visão completa.</h2><p className="mt-5 max-w-sm text-sm leading-6 text-blue-100">Worklist, imagens DICOM e monitoramento do servidor em uma experiência clínica rápida e segura.</p><div className="mt-10 grid grid-cols-3 gap-3">{[[Database,'Worklist'],[Activity,'Viewer'],[Server,'Servidor']].map(([Icon,label]) => { const C = Icon as typeof Database; return <div key={String(label)} className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur"><C size={20} className="text-cyan-200" /><div className="mt-3 text-xs font-medium">{String(label)}</div></div>; })}</div></div>
            <div className="relative flex items-center gap-2 text-xs text-blue-200"><Shield size={14} /> Ambiente local protegido</div>
          </aside>
        <form onSubmit={submitLogin} className="relative flex min-h-[620px] w-full flex-col justify-center overflow-hidden bg-white p-8 sm:p-12">
          <div className="absolute left-0 right-0 top-0 h-48 -translate-y-24 bg-gradient-to-b from-blue-200 via-cyan-100 to-transparent opacity-50 blur-3xl" />

          <div className="relative mb-8 flex flex-col items-center text-center">
            <div className="mb-6 rounded-2xl bg-white p-4 shadow-lg ring-1 ring-slate-100">
              <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-gradient-to-br from-blue-950 to-blue-700 p-2 shadow-sm">
                <img src="./brand/pacs-chx-logo.png" alt="PACS CHX" className="block h-full w-full object-contain" />
              </div>
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-slate-950">Bem-vindo</h1>
              <p className="mt-2 text-sm text-slate-500">Acesse sua estação clínica PACS CHX</p>
            </div>
          </div>

          <label className="relative mb-5 block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">Usuario</span>
            <input
              value={loginUser}
              onChange={(event) => setLoginUser(event.target.value)}
              placeholder="Digite seu usuario"
              className="h-12 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
              autoFocus
            />
          </label>

          <label className="mb-5 block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">Senha</span>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                placeholder="Digite sua senha"
                className="h-12 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 pr-12 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
              />
              <button
                type="button"
                onClick={() => setShowPassword((show) => !show)}
                className="absolute right-1 top-1/2 flex h-10 -translate-y-1/2 items-center justify-center rounded-md px-3 text-slate-400 transition hover:bg-slate-100 hover:text-blue-600"
                title={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>

          {preAuthToken && <label className="mb-5 block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Código de 6 dígitos</span><input autoFocus inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={mfaCode} onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, ''))} placeholder="000000" className="h-12 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-center font-mono text-lg tracking-[.35em] outline-none focus:border-blue-500"/><button type="button" onClick={() => { setPreAuthToken(''); setMfaCode(''); }} className="mt-2 text-xs text-blue-600">Voltar</button></label>}

          {loginError && (
            <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {loginError}
            </div>
          )}

          <button disabled={!configLoaded} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-800 to-blue-600 text-sm font-semibold text-white shadow-lg shadow-blue-700/20 transition hover:-translate-y-0.5 hover:shadow-xl active:translate-y-0 disabled:cursor-wait disabled:opacity-60">
            <LockKeyhole size={16} />{configLoaded ? preAuthToken ? 'Verificar código MFA' : 'Entrar no PACS' : 'Conectando ao servidor...'}
          </button>

          <div className="mt-6 flex items-center">
            <div className="h-px flex-1 bg-slate-200" />
            <span className="px-4 text-xs text-slate-400">acesso protegido</span>
            <div className="h-px flex-1 bg-slate-200" />
          </div>

          <p className="mt-5 text-center text-xs text-slate-500">
            Credenciais gerenciadas pelo administrador do PACS CHX.
          </p>
        </form></div>
      </div>
    );
  }

  return <div className="flex h-full flex-col overflow-hidden bg-slate-100 text-slate-900 select-none">
    {activeTab?.kind !== 'viewer' && <header className="flex min-h-14 items-stretch bg-gradient-to-r from-[#071d3d] via-[#082f65] to-[#082f65] shadow-lg shadow-blue-950/20">
      <div className="flex w-[248px] flex-shrink-0 items-center gap-3 px-4 text-white">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-500 p-1.5 shadow-lg shadow-blue-950/25"><img src="./brand/pacs-chx-logo.png" alt="PACS CHX" className="block h-full w-full object-contain" /></div>
        <div><div className="text-sm font-bold tracking-wide">PACS CHX</div><div className="text-[9px] font-semibold uppercase tracking-[0.2em] text-cyan-200">Clinical Imaging</div></div>
      </div>
      <div className="flex flex-1 overflow-hidden">
        {tabs.map((tab) => <div key={tab.id} onClick={() => setActiveTabId(tab.id)} className={`group my-2 ml-2 flex cursor-pointer items-center gap-1.5 rounded-lg px-3 text-sm transition ${tab.id === activeTabId ? 'bg-white text-blue-900 shadow-md' : 'text-blue-100 hover:bg-white/10'}`}>
          {tab.kind === 'worklist' && <List size={14} />}{tab.kind === 'worklistSchedule' && <ClipboardList size={14} />}{tab.kind === 'status' && <Activity size={14} />}{tab.kind === 'settings' && <SettingsIcon size={14} />}
          <span className="max-w-[100px] truncate">{tab.label}</span>
          {!['worklist', 'worklistSchedule'].includes(tab.kind) && <button onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }} className="ml-1 rounded p-0.5 text-slate-500 hover:bg-slate-600 hover:text-white"><X size={12} /></button>}
        </div>)}
      </div>
      <div className="hidden items-center gap-2 border-l border-white/15 px-4 text-xs text-blue-50 md:flex"><span className="h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_0_3px_rgba(110,231,183,0.18)]" /><span>Servidor conectado</span></div>
      <div ref={adminRef} className="relative">
        <button onClick={() => setAdminMenuOpen((open) => !open)} className="flex h-full items-center gap-2 px-4 text-sm text-slate-200 hover:bg-white/5"><Shield size={15} className="text-cyan-300" /><span className="hidden sm:inline">{displayName || loginUser}</span><ChevronDown size={14} /></button>
        {adminMenuOpen && <div className="absolute right-2 top-[calc(100%+8px)] z-50 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white py-1.5 text-slate-700 shadow-2xl"><div className="flex items-center gap-2 border-b border-slate-100 px-3 py-3 text-xs text-slate-500"><User size={14} />{loginUser || 'admin'}@pacschx</div><button onClick={() => { addSystemTab('status', 'Status'); setAdminMenuOpen(false); }} className="flex w-full items-center gap-2 px-3 py-2.5 text-sm hover:bg-blue-50 hover:text-blue-700"><Activity size={14} />Status do servidor</button><button onClick={() => { addSystemTab('settings', 'Configurações'); setAdminMenuOpen(false); }} className="flex w-full items-center gap-2 px-3 py-2.5 text-sm hover:bg-blue-50 hover:text-blue-700"><SettingsIcon size={14} />Configurações</button><button onClick={() => { void apiFetch('/api/auth/logout', { method: 'POST' }); setClinicalToken(null); setAuthenticated(false); setLoginPassword(''); setAdminMenuOpen(false); }} className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2.5 text-sm text-red-600 hover:bg-red-50"><LogOut size={14} />Sair</button></div>}
      </div>
    </header>}
      <div className="flex flex-1 overflow-hidden"><Suspense fallback={suspenseFallback}>{activeTab?.kind === 'worklist' && <Worklist store={store} onOpenStudy={openStudy} userRole={userRole} />}{activeTab?.kind === 'worklistSchedule' && <div className="flex-1 overflow-auto bg-[#f3f7fc]"><WorklistTab store={store} /></div>}{activeTab?.kind === 'viewer' && activeTab.study && <Viewer key={activeTab.study.id} study={activeTab.study} allSeries={store.series} />}{activeTab?.kind === 'status' && <Status store={store} />}{activeTab?.kind === 'settings' && <div className="flex flex-1 flex-col overflow-auto"><Settings store={store} />{['admin', 'master'].includes(userRole) && <div className="p-5 pt-0"><TotpSetup /></div>}</div>}</Suspense></div>
  </div>;
}
