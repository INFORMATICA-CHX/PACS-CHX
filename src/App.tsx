import { useState, useRef, useEffect } from 'react';
import { X, Shield, ChevronDown, List, Activity, Settings as SettingsIcon, LogOut, User, LockKeyhole } from 'lucide-react';
import { ManagerPanel } from '@/components/ManagerPanel';
import { Worklist } from '@/components/Worklist';
import { Viewer } from '@/components/Viewer';
import { Status } from '@/components/Status';
import { Settings } from '@/components/Settings';
import { usePacsStore } from '@/lib/usePacsStore';
import type { Study } from '@/types';

type TabKind = 'worklist' | 'viewer' | 'status' | 'settings';

interface Tab {
  id: string;
  kind: TabKind;
  label: string;
  study?: Study;
}

export default function App() {
  const [managerOpen, setManagerOpen] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('viewer') !== '1';
  });
  const [authenticated, setAuthenticated] = useState(false);
  const store = usePacsStore({ loadClinicalData: !managerOpen && authenticated });

  const [tabs, setTabs] = useState<Tab[]>([
    { id: 'worklist', kind: 'worklist', label: 'Lista' },
  ]);
  const [activeTabId, setActiveTabId] = useState('worklist');
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const [loginUser, setLoginUser] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const adminRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (adminRef.current && !adminRef.current.contains(e.target as Node)) setAdminMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const openStudy = (study: Study) => {
    const existing = tabs.find((t) => t.kind === 'viewer' && t.study?.id === study.id);
    if (existing) { setActiveTabId(existing.id); return; }
    const tabId = `viewer_${study.id}_${Date.now()}`;
    const label = study.patientName.split('^')[0] || 'Estudo';
    setTabs((prev) => [...prev, { id: tabId, kind: 'viewer', label, study }]);
    setActiveTabId(tabId);
  };

  const closeTab = (id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx < 0) return prev;
      const next = prev.filter((t) => t.id !== id);
      if (activeTabId === id) {
        const fallback = next[Math.max(0, idx - 1)] ?? next[0];
        setActiveTabId(fallback?.id ?? 'worklist');
      }
      return next;
    });
  };

  const addSystemTab = (kind: TabKind, label: string) => {
    const existing = tabs.find((t) => t.kind === kind);
    if (existing) { setActiveTabId(existing.id); return; }
    const tabId = `${kind}_${Date.now()}`;
    setTabs((prev) => [...prev, { id: tabId, kind, label }]);
    setActiveTabId(tabId);
  };

  const showWorklist = () => {
    window.history.replaceState(null, '', `${window.location.pathname}?viewer=1`);
    setManagerOpen(false);
    setAuthenticated(false);
    setActiveTabId('worklist');
  };

  if (managerOpen) {
    return <ManagerPanel store={store} onOpenViewer={showWorklist} />;
  }

  const activeTab = tabs.find((t) => t.id === activeTabId);

  const submitLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (loginUser.trim() === store.config.viewerUser && loginPassword === store.config.viewerPassword) {
      setAuthenticated(true);
      setLoginError('');
      store.addLog('success', `Login do Viewer realizado por ${loginUser.trim()}`, 'AUTH');
      return;
    }
    setLoginError('Usuario ou senha invalidos.');
    store.addLog('warning', `Falha de login no Viewer para ${loginUser.trim() || '(vazio)'}`, 'AUTH');
  };

  if (!authenticated) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-950 px-4">
        <form onSubmit={submitLogin} className="w-full max-w-sm rounded-lg border border-slate-800 bg-slate-900 p-6 shadow-2xl">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-cyan-500 text-slate-950">
              <LockKeyhole size={20} />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-white">Login do Viewer</h1>
              <p className="text-xs text-slate-400">Acesso a Worklist DICOM</p>
            </div>
          </div>

          <label className="mb-3 block">
            <span className="mb-1.5 block text-sm font-medium text-slate-300">Usuario</span>
            <input
              value={loginUser}
              onChange={(e) => setLoginUser(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
              autoFocus
            />
          </label>

          <label className="mb-4 block">
            <span className="mb-1.5 block text-sm font-medium text-slate-300">Senha</span>
            <input
              type="password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
            />
          </label>

          {loginError && (
            <div className="mb-4 rounded-md border border-red-900/70 bg-red-950/60 px-3 py-2 text-sm text-red-200">
              {loginError}
            </div>
          )}

          <button className="w-full rounded-md bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400">
            Entrar
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex flex-col bg-slate-100 select-none" style={{ height: '100%', width: '100%', overflow: 'hidden' }}>
      {/* Top tab bar */}
      <div className="flex items-center bg-slate-800 border-b border-slate-700" style={{ flexShrink: 0 }}>
        {/* Logo / back to manager */}
        <button
          onClick={() => setManagerOpen(true)}
          className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-700 hover:text-white"
        >
          <div className="flex h-6 w-6 items-center justify-center rounded bg-cyan-500 text-slate-950 font-bold text-xs">P</div>
        </button>

        {/* Tabs */}
        <div className="flex items-center" style={{ minWidth: 0, flex: '1 1 auto', overflow: 'hidden' }}>
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                className={`group flex items-center gap-1.5 px-3 py-2 text-sm cursor-pointer border-r border-slate-700 transition-colors ${
                  active ? 'bg-slate-900 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
                }`}
              >
                {tab.kind === 'worklist' && <List size={14} className={active ? 'text-cyan-400' : ''} />}
                {tab.kind === 'status' && <Activity size={14} className={active ? 'text-cyan-400' : ''} />}
                {tab.kind === 'settings' && <SettingsIcon size={14} className={active ? 'text-cyan-400' : ''} />}
                <span className="max-w-[100px] truncate" style={{ minWidth: 0 }}>{tab.label}</span>
                {tab.kind !== 'worklist' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                    className="ml-1 rounded p-0.5 text-slate-500 hover:bg-slate-600 hover:text-white"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Administrator dropdown */}
        <div ref={adminRef} className="relative" style={{ flexShrink: 0 }}>
          <button
            onClick={() => setAdminMenuOpen((o) => !o)}
            className="flex items-center gap-2 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 hover:text-white"
          >
            <Shield size={15} className="text-cyan-400" />
            <span>Administrator</span>
            <ChevronDown size={14} className={`transition-transform ${adminMenuOpen ? 'rotate-180' : ''}`} />
          </button>
          {adminMenuOpen && (
            <div className="absolute right-0 top-full w-48 rounded-md border border-slate-600 bg-slate-800 py-1 shadow-xl z-50">
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500 border-b border-slate-700">
                <User size={14} /> admin@pacschx
              </div>
              <MenuItem icon={<Activity size={14} />} label="Status do Servidor" onClick={() => { addSystemTab('status', 'Status'); setAdminMenuOpen(false); }} />
              <MenuItem icon={<SettingsIcon size={14} />} label="Configurações" onClick={() => { addSystemTab('settings', 'Configurações'); setAdminMenuOpen(false); }} />
              <div className="my-1 border-t border-slate-700" />
              <MenuItem icon={<LogOut size={14} />} label="Voltar ao Gerenciador" onClick={() => { setManagerOpen(true); setAdminMenuOpen(false); }} />
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 overflow-hidden" style={{ minHeight: 0, minWidth: 0 }}>
        {activeTab?.kind === 'worklist' && <Worklist store={store} onOpenStudy={openStudy} userRole="master" />}
        {activeTab?.kind === 'viewer' && activeTab.study && (
          <Viewer study={activeTab.study} allSeries={store.series} />
        )}
        {activeTab?.kind === 'status' && <Status store={store} />}
        {activeTab?.kind === 'settings' && <Settings store={store} />}
      </div>
    </div>
  );
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 hover:text-white">
      {icon}
      {label}
    </button>
  );
}
