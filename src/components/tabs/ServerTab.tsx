import { useEffect, useState } from 'react';
import { FolderOpen, Save, Server, Globe2 } from 'lucide-react';
import type { PacsStore } from '@/lib/usePacsStore';
import type { ServerConfig } from '@/types';

interface ServerTabProps { store: PacsStore }

export function ServerTab({ store }: ServerTabProps) {
  const { config, setConfig, addLog } = store;
  const [local, setLocal] = useState(config);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const update = (patch: Partial<ServerConfig>) => { setLocal((current) => ({ ...current, ...patch })); setDirty(true); };

  useEffect(() => {
    if (!dirty) setLocal(config);
  }, [config, dirty]);

  const chooseFolder = async (target: 'storagePath' | 'dbPath' | 'logPath') => {
    const folder = await window.localPacs?.openFolder();
    if (!folder) return;
    if (target === 'dbPath') update({ dbPath: `${folder}\\pacs.db` });
    else update({ [target]: folder });
  };

  const save = async () => {
    if (!local.aeTitle.trim() || [local.listenPort, local.apiPort].some((port) => port < 1 || port > 65535)) {
      addLog('error', 'Confira o AE Title e as portas informadas', 'CONFIG');
      return;
    }
    setSaving(true);
    const { viewerPassword: _viewerPassword, ...payload } = local;
    try {
      const response = await fetch(`http://127.0.0.1:${config.apiPort}/api/config`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error ?? 'O servidor recusou a configuracao');
      }
      const result = await response.json();
      const saved = { ...local, ...result, viewerPassword: local.viewerPassword } as ServerConfig;
      setConfig(saved); setLocal(saved);
      setDirty(false);
      addLog('success', `Servidor configurado: ${saved.aeTitle} em ${saved.listenIp}:${saved.listenPort}`, 'CONFIG');
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Falha ao salvar';
      const message = /EADDRINUSE|address already in use/i.test(rawMessage)
        ? `${rawMessage}\n\nA porta DICOM ja esta em uso. Feche outro PACS CHX/DICOMApp aberto nesse computador ou escolha uma porta DICOM livre.`
        : rawMessage;
      addLog('error', message, 'CONFIG');
      alert(message);
    } finally { setSaving(false); }
  };

  const field = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500';
  return <div className="space-y-4 p-5">
    <section className="rounded-xl border bg-white">
      <div className="flex items-center gap-2 border-b px-4 py-3 text-xs font-semibold uppercase text-slate-500"><Server size={15}/> Serviço DICOM</div>
      <div className="grid gap-4 p-5 md:grid-cols-2">
        <Field label="AE Title"><input className={field} value={local.aeTitle} maxLength={16} onChange={(e) => update({ aeTitle: e.target.value.toUpperCase() })}/></Field>
        <Field label="IP de escuta"><input className={field} value={local.listenIp} onChange={(e) => update({ listenIp: e.target.value })}/></Field>
        <Field label="Porta DICOM"><input className={field} type="number" value={local.listenPort} onChange={(e) => update({ listenPort: Number(e.target.value) })}/></Field>
        <label className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"><input type="checkbox" checked={Boolean(local.dicom?.acceptUnknownSources)} onChange={(e) => update({ dicom: { ...(local.dicom ?? {}), acceptUnknownSources: e.target.checked } })}/> Aceitar fontes DICOM não cadastradas</label>
        <Field label="Banco SQLite"><div className="flex gap-2"><input className={field} value={local.dbPath} onChange={(e) => update({ dbPath: e.target.value })}/><button onClick={() => void chooseFolder('dbPath')} className="flex items-center gap-2 border px-4 text-sm"><FolderOpen size={15}/> Pasta</button></div></Field>
        <Field label="Pasta das imagens DICOM"><div className="flex gap-2"><input className={field} value={local.storagePath} onChange={(e) => update({ storagePath: e.target.value })}/><button onClick={() => void chooseFolder('storagePath')} className="flex items-center gap-2 border px-4 text-sm"><FolderOpen size={15}/> Pasta</button></div></Field>
        <div className="md:col-span-2"><Field label="Pasta dos logs"><div className="flex gap-2"><input className={field} value={local.logPath} onChange={(e) => update({ logPath: e.target.value })}/><button onClick={() => void chooseFolder('logPath')} className="flex items-center gap-2 border px-4 text-sm"><FolderOpen size={15}/> Pasta</button></div></Field></div>
      </div>
    </section>
    <section className="rounded-xl border bg-white">
      <div className="flex items-center gap-2 border-b px-4 py-3 text-xs font-semibold uppercase text-slate-500"><Globe2 size={15}/> Servidor Web</div>
      <div className="grid gap-4 p-5 md:grid-cols-2">
        <Field label="Porta HTTP / API"><input className={field} type="number" value={local.apiPort} onChange={(e) => update({ apiPort: Number(e.target.value) })}/><p className="mt-1 text-xs text-amber-600">Alterar esta porta exige reiniciar o Electron.</p></Field>
        <Field label="Endereço do Viewer"><input className={`${field} bg-slate-50 text-slate-500`} readOnly value={`http://127.0.0.1:${local.apiPort}/viewer`}/></Field>
      </div>
    </section>
    <div className="flex justify-end gap-2"><button onClick={() => { setLocal(config); setDirty(false); }} className="border px-5 py-2 text-sm">Cancelar</button><button disabled={saving} onClick={() => void save()} className="flex items-center gap-2 bg-blue-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"><Save size={15}/>{saving ? 'Salvando...' : 'Salvar e aplicar'}</button></div>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>{children}</label>;
}
