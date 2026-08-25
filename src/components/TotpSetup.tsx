import { useState } from 'react';
import QRCode from 'qrcode';
import { apiFetch } from '@/lib/apiClient';

export function TotpSetup() {
  const [qr, setQr] = useState(''); const [secret, setSecret] = useState(''); const [code, setCode] = useState(''); const [message, setMessage] = useState('');
  const setup = async () => {
    setMessage(''); const response = await apiFetch('/api/auth/totp/setup', { method: 'POST' }); const result = await response.json();
    if (!response.ok) return setMessage(result.error ?? 'Não foi possível iniciar o MFA.');
    setSecret(result.secret); setQr(await QRCode.toDataURL(result.uri, { width: 220, margin: 1 }));
  };
  const confirm = async () => {
    const response = await apiFetch('/api/auth/totp/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }); const result = await response.json();
    if (!response.ok) return setMessage(result.error ?? 'Código inválido.');
    setMessage('MFA ativado com sucesso. Ele será exigido no próximo login.'); setQr(''); setSecret(''); setCode('');
  };
  return <section className="rounded-xl border border-slate-200 bg-white p-5"><h3 className="font-semibold text-slate-900">Autenticação multifator (TOTP)</h3><p className="mt-1 text-sm text-slate-500">Proteja esta conta com Microsoft Authenticator, Google Authenticator ou aplicativo compatível.</p>{!qr && <button onClick={() => void setup()} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white">Configurar autenticador</button>}{qr && <div className="mt-4 flex flex-wrap gap-5"><img src={qr} alt="QR code TOTP" className="h-[220px] w-[220px] rounded-lg border"/><div className="min-w-64 flex-1"><p className="text-xs text-slate-500">Escaneie o QR code. Se necessário, use esta chave:</p><code className="mt-2 block break-all rounded bg-slate-100 p-2 text-xs">{secret}</code><label className="mt-4 block text-xs font-medium text-slate-600">Código de confirmação</label><input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} className="mt-1 w-full rounded-lg border px-3 py-2 font-mono tracking-[.25em]"/><button onClick={() => void confirm()} disabled={code.length !== 6} className="mt-3 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Confirmar e ativar</button></div></div>}{message && <p className="mt-3 text-sm text-blue-700">{message}</p>}</section>;
}
