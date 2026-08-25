import { useEffect, useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import type { PacsStore } from '@/lib/usePacsStore';

export function ServiceLogin({ api, onAuthorized, addLog }: { api: string; onAuthorized: (token: string) => void; addLog: PacsStore['addLog'] }) {
  const [configured, setConfigured] = useState<boolean>();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [preAuthToken, setPreAuthToken] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  useEffect(() => { fetch(`${api}/api/service/status`).then((response) => response.json()).then((result) => setConfigured(result.configured)).catch(() => setError('Servidor indisponível.')); }, [api]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError('');
    if (configured === false && password !== confirmation) { setError('As senhas não coincidem.'); return; }
    setLoading(true);
    try {
      const path = preAuthToken ? 'totp/verify' : configured ? 'login' : 'setup';
      const response = await fetch(`${api}/api/service/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preAuthToken ? { preAuthToken, code: mfaCode } : { password }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (result.mfaRequired) { setPreAuthToken(result.preAuthToken); return; }
      onAuthorized(result.token);
      addLog('success', configured ? 'Acesso de manutenção autorizado' : 'Senha de serviço configurada', 'SECURITY');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Acesso negado.'); }
    finally { setLoading(false); }
  };
  return <div className="grid h-full min-h-[390px] place-items-center p-6"><form onSubmit={(event) => void submit(event)} className="w-full max-w-md rounded-2xl border border-blue-100 bg-white p-6 shadow-xl shadow-blue-900/5"><div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl bg-blue-50 text-blue-700"><LockKeyhole size={23}/></div><h2 className="text-center text-lg font-bold text-slate-900">{preAuthToken ? 'Segundo fator' : configured === false ? 'Criar senha de serviço' : 'Acesso de manutenção'}</h2><p className="mb-5 mt-1 text-center text-xs text-slate-500">{preAuthToken ? 'Informe o código de 6 dígitos do autenticador.' : configured === false ? 'Defina sua senha pessoal. Apenas o hash será armazenado.' : 'Informe a senha do técnico responsável para continuar.'}</p>{preAuthToken ? <label className="block"><span className="mb-1 block text-xs font-medium text-slate-600">Código TOTP</span><input autoFocus inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))} className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-center font-mono tracking-[.3em] outline-none focus:border-blue-500"/></label> : <><label className="block"><span className="mb-1 block text-xs font-medium text-slate-600">Senha de serviço</span><input autoFocus type="password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-blue-500"/></label>{configured === false && <label className="mt-3 block"><span className="mb-1 block text-xs font-medium text-slate-600">Confirmar senha</span><input type="password" minLength={10} required value={confirmation} onChange={(e) => setConfirmation(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-blue-500"/></label>}</>}{error && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}<button disabled={loading || configured === undefined} className="mt-5 w-full rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{loading ? 'Validando...' : preAuthToken ? 'Verificar código' : configured === false ? 'Criar senha e entrar' : 'Entrar na manutenção'}</button></form></div>;
}
