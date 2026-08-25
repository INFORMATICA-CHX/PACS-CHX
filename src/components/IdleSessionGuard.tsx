import { useEffect, useState } from 'react';
import { getClinicalToken } from '@/lib/apiClient';
import { useIdleTimer } from '@/lib/idleTimer';

export function IdleSessionGuard({ children }: { children: React.ReactNode }) {
  const [minutes, setMinutes] = useState(15);
  const [active, setActive] = useState(Boolean(getClinicalToken()));
  useEffect(() => {
    fetch('/api/config').then((response) => response.json()).then((config) => setMinutes(Number(config.session?.idleTimeoutMinutes) || 15)).catch(() => undefined);
    const sync = () => setActive(Boolean(getClinicalToken()));
    window.addEventListener('pacs-token-changed', sync);
    return () => window.removeEventListener('pacs-token-changed', sync);
  }, []);
  const { warning, continueSession } = useIdleTimer(minutes, active, () => { setActive(false); window.location.assign('/'); });
  return <>{children}{warning && <div className="fixed inset-0 z-[9999] grid place-items-center bg-slate-950/60 p-4"><div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-2xl"><h2 className="text-lg font-bold text-slate-900">Sessão prestes a encerrar</h2><p className="mt-2 text-sm text-slate-600">A sessão será encerrada em 60 segundos por inatividade.</p><button onClick={continueSession} className="mt-5 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white">Continuar conectado</button></div></div>}</>;
}
