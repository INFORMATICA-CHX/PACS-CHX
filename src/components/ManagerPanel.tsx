import { useEffect, useState } from 'react';
import { Activity, Cable, Database, Globe, HardDrive, Home, KeyRound, Radio, Server, Settings2 } from 'lucide-react';
import type { PacsStore } from '@/lib/usePacsStore';
import { HomeTab } from '@/components/tabs/HomeTab';
import { ServerTab } from '@/components/tabs/ServerTab';
import { DatabaseTab } from '@/components/tabs/DatabaseTab';
import { ConnectionTab } from '@/components/tabs/ConnectionTab';
import { LicenseTab } from '@/components/tabs/LicenseTab';
import { LocalizationTab } from '@/components/tabs/LocalizationTab';

type ManagerTab = 'home' | 'server' | 'database' | 'connection' | 'license' | 'localization';
interface Props { store: PacsStore; onOpenViewer: () => void }
const tabs = [
  { id: 'home', label: 'Visão geral', description: 'Operação e acesso', icon: Home },
  { id: 'server', label: 'Servidor', description: 'DICOM e API', icon: Server },
  { id: 'database', label: 'Banco de dados', description: 'Storage e backup', icon: Database },
  { id: 'connection', label: 'Conexões', description: 'Nós DICOM', icon: Cable },
  { id: 'license', label: 'Licença', description: 'Plano e limites', icon: KeyRound },
  { id: 'localization', label: 'Localização', description: 'Idioma e região', icon: Globe },
] as const;

export function ManagerPanel({ store, onOpenViewer }: Props) {
  const [tab, setTab] = useState<ManagerTab>('home');
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    void window.localPacs?.getAppVersion().then(setAppVersion).catch(() => {});
  }, []);
  const { status, config } = store;
  const active = tabs.find((item) => item.id === tab)!;
  const ActiveIcon = active.icon;
  const uptime = status.startedAt ? formatUptime(status.startedAt) : '—';
  return <div className="manager-v2 flex h-full min-w-0 overflow-hidden bg-[#f3f7fc] text-slate-800">
    <aside className="manager-sidebar flex w-[246px] shrink-0 flex-col text-white">
      <div className="flex items-center gap-3 border-b border-white/10 px-5 py-5"><div className="grid h-12 w-12 place-items-center rounded-2xl border border-white/20 bg-white/10 p-1.5 shadow-inner"><img src="./brand/pacs-chx-logo.png" alt="PACS CHX" className="block h-full w-full object-contain"/></div><div><div className="text-base font-bold tracking-wide">PACS CHX</div><div className="text-[10px] font-semibold uppercase tracking-[.19em] text-blue-200">Server Console</div></div></div>
      <div className="mx-4 mt-4 rounded-xl border border-white/10 bg-white/[.07] p-3"><div className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${status.running ? 'bg-emerald-300 shadow-[0_0_0_4px_rgba(110,231,183,.13)]' : 'bg-rose-300'}`}/><span className="text-xs font-semibold">{status.running ? 'Sistema operacional' : 'Sistema parado'}</span></div><div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-blue-200"><span>PID <b className="block text-xs text-white">{status.pid ?? '—'}</b></span><span>Uptime <b className="block text-xs text-white">{uptime}</b></span></div></div>
      <div className="px-4 pb-2 pt-5 text-[10px] font-bold uppercase tracking-[.16em] text-blue-300">Administração</div>
      <nav className="space-y-1 px-3">{tabs.map((item) => { const Icon = item.icon; const selected = tab === item.id; return <button key={item.id} onClick={() => setTab(item.id)} className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${selected ? 'bg-white text-blue-900 shadow-lg shadow-blue-950/20' : 'text-blue-100 hover:bg-white/10 hover:text-white'}`}><span className={`grid h-8 w-8 place-items-center rounded-lg ${selected ? 'bg-blue-100 text-blue-700' : 'bg-white/10'}`}><Icon size={16}/></span><span className="min-w-0"><span className="block text-sm font-semibold">{item.label}</span><span className={`block truncate text-[10px] ${selected ? 'text-blue-500' : 'text-blue-300'}`}>{item.description}</span></span></button>; })}</nav>
      <div className="mt-auto border-t border-white/10 p-4"><div className="flex items-center gap-2 text-xs text-blue-200"><ShieldDot/><span>Ambiente local protegido</span></div><div className="mt-2 text-[10px] text-blue-300">PACS CHX Server · v{appVersion || '—'}</div></div>
    </aside>
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="manager-topbar flex min-h-[76px] items-center border-b bg-white px-6"><div className="grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-blue-700"><ActiveIcon size={20}/></div><div className="ml-3"><h1 className="text-lg font-bold tracking-tight text-slate-900">{active.label}</h1><p className="text-xs text-slate-500">{active.description} · configuração local do servidor</p></div><div className="ml-auto flex items-center gap-3"><div className="hidden text-right md:block"><div className="text-xs font-semibold text-slate-700">{config.aeTitle}</div><div className="font-mono text-[10px] text-slate-400">{config.listenIp}:{config.listenPort}</div></div><div className={`grid h-10 w-10 place-items-center rounded-xl ${status.running ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}><Activity size={19}/></div></div></header>
      <div className="manager-content flex-1 overflow-auto">{tab === 'home' && <HomeTab store={store} onOpenViewer={onOpenViewer}/>} {tab === 'server' && <ServerTab store={store}/>} {tab === 'database' && <DatabaseTab store={store}/>} {tab === 'connection' && <ConnectionTab store={store}/>} {tab === 'license' && <LicenseTab store={store}/>} {tab === 'localization' && <LocalizationTab store={store}/>}</div>
      <footer className="manager-statusbar flex min-h-9 items-center gap-4 border-t px-5 text-[11px]"><span className={`h-2 w-2 rounded-full ${status.running ? 'bg-emerald-500' : 'bg-red-500'}`}/><b className={status.running ? 'text-emerald-700' : 'text-red-700'}>{status.running ? 'ONLINE' : 'OFFLINE'}</b><span className="flex items-center gap-1 text-slate-500"><Radio size={12}/> DICOM <b className="font-mono text-slate-700">:{config.listenPort}</b></span><span className="flex items-center gap-1 text-slate-500"><Settings2 size={12}/> API <b className="font-mono text-slate-700">:{config.apiPort}</b></span><span className="flex min-w-0 items-center gap-1 text-slate-500"><HardDrive size={12}/><span className="max-w-[300px] truncate font-mono text-slate-700" title={config.storagePath}>{config.storagePath}</span></span>{status.lastError ? <span className="ml-auto max-w-64 truncate text-red-600" title={status.lastError}>{status.lastError}</span> : <span className="ml-auto text-slate-400">Monitoramento em tempo real</span>}</footer>
    </main>
  </div>;
}
function formatUptime(startedAt: string) { const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)); return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`; }
function ShieldDot() { return <span className="grid h-5 w-5 place-items-center rounded-md bg-emerald-400/15"><span className="h-1.5 w-1.5 rounded-full bg-emerald-300"/></span>; }

