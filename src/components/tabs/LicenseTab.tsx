import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, KeyRound, ShieldCheck } from 'lucide-react';
import type { PacsStore } from '@/lib/usePacsStore';

interface LicenseInfo { customer: string; machineId: string; plan: string; expiresAt: string | null; issuedAt: string; licenseId: string; limits: { maxStorageGb: number; maxDevices: number; maxUsers: number | null; maxStudies: number | null }; features: string[] }
interface LicenseState { active: boolean; machineId?: string; key?: string; license?: LicenseInfo; activatedAt?: string; error?: string }

export function LicenseTab({ store }: { store: PacsStore }) {
  const { config, addLog } = store;
  const api = `http://127.0.0.1:${config.apiPort}`;
  const [state, setState] = useState<LicenseState>({ active: false });
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${api}/api/license`);
      setState(await response.json());
    } catch {
      setState({ active: false, error: 'Servidor indisponível' });
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const normalizeLicenseKey = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed) as { key?: unknown };
      if (typeof parsed.key !== 'string') throw new Error('Arquivo .chxlic sem campo key.');
      return parsed.key.trim();
    }
    const match = trimmed.match(/CHX1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    return match?.[0] ?? trimmed;
  };

  const activate = async () => {
    setBusy(true);
    try {
      const licenseKey = normalizeLicenseKey(key);
      const response = await fetch(`${api}/api/license/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: licenseKey }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setState(result);
      setKey('');
      addLog('success', 'Licença assinada ativada', 'LICENSE');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Licença inválida';
      addLog('error', message, 'LICENSE');
      alert(message);
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    if (!confirm('Desativar a licença deste servidor?')) return;
    const response = await fetch(`${api}/api/license`, { method: 'DELETE' });
    setState(await response.json());
    addLog('warning', 'Licença desativada', 'LICENSE');
  };

  const license = state.license;
  return (
    <div className="space-y-4 p-5">
      <section>
        <div className="flex items-center gap-2 border-b px-4 py-3 text-xs font-semibold uppercase text-slate-500"><ShieldCheck size={15}/> Licença instalada</div>
        <div className="p-5">
          {state.active && license ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4"><CheckCircle2 className="text-emerald-600"/><div><div className="font-semibold text-emerald-800">Licença válida e assinada</div><div className="text-sm text-emerald-700">{license.customer} · {license.plan}</div></div></div>
              <div className="grid gap-3 md:grid-cols-4"><Info label="Armazenamento" value={`${license.limits.maxStorageGb} GB`}/><Info label="Dispositivos" value={String(license.limits.maxDevices)}/><Info label="Usuários" value={formatLimit(license.limits.maxUsers)}/><Info label="Estudos" value={formatLimit(license.limits.maxStudies)}/><Info label="Validade" value={formatExpiration(license.expiresAt)}/><Info label="ID" value={license.licenseId}/></div>
              <div className="text-xs text-slate-500">Recursos: {license.features.join(', ')}</div>
              <button onClick={() => void deactivate()} className="border px-4 py-2 text-sm text-red-600">Desativar licença</button>
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4"><AlertTriangle className="text-amber-600"/><div><div className="font-semibold text-amber-800">Servidor não licenciado</div><div className="text-sm text-amber-700">{state.error || 'Emita uma licença no software PACS CHX License Manager.'}</div></div></div>
          )}
        </div>
      </section>
      <section>
        <div className="flex items-center gap-2 border-b px-4 py-3 text-xs font-semibold uppercase text-slate-500"><KeyRound size={15}/> Ativar licença</div>
        <div className="space-y-3 p-5">
          <p className="text-sm text-slate-600">Código deste servidor: <b className="select-all font-mono">{state.machineId || 'indisponível'}</b>. Envie esse código ao emissor; a licença funcionará somente neste computador.</p>
          <p className="text-sm text-slate-600">Cole a chave <b>CHX1...</b> ou o conteúdo completo do arquivo <b>.chxlic</b>.</p>
          <textarea value={key} onChange={(e) => setKey(e.target.value)} className="min-h-28 w-full rounded-lg border border-slate-300 p-3 font-mono text-xs outline-none focus:border-blue-500" placeholder="CHX1..."/>
          <div className="flex justify-end"><button disabled={!key.trim() || busy} onClick={() => void activate()} className="bg-blue-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-40">{busy ? 'Validando...' : 'Ativar e validar assinatura'}</button></div>
        </div>
      </section>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border bg-slate-50 p-3"><div className="text-xs text-slate-500">{label}</div><div className="mt-1 break-all text-sm font-semibold text-slate-800">{value}</div></div>;
}

function formatLimit(value: number | null) {
  return Number.isFinite(value) ? Number(value).toLocaleString('pt-BR') : 'Ilimitado';
}

function formatExpiration(value: string | null) {
  if (!value) return 'Perpétua';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T12:00:00` : value);
  return dateOnly ? date.toLocaleDateString('pt-BR') : date.toLocaleString('pt-BR');
}

