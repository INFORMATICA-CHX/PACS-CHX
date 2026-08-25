import { useState } from 'react';
import { Globe, Save } from 'lucide-react';
import type { PacsStore } from '@/lib/usePacsStore';

interface LocalizationTabProps { store: PacsStore }

export function LocalizationTab({ store }: LocalizationTabProps) {
  const { addLog } = store;
  const [language, setLanguage] = useState('pt-BR');
  const [dateFormat, setDateFormat] = useState('DD/MM/YYYY');
  const [timeFormat, setTimeFormat] = useState('24h');

  const langs = [
    { code: 'pt-BR', label: 'Português (Brasil)' },
    { code: 'en-US', label: 'English (US)' },
    { code: 'es-ES', label: 'Español (España)' },
  ];

  return (
    <div className="p-5 space-y-4">
      <section className="rounded border border-gray-300 bg-white">
        <div className="border-b border-gray-300 bg-gray-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 flex items-center gap-2">
          <Globe size={14} /> Idioma e Região
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Idioma da interface</label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full max-w-sm rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            >
              {langs.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Formato de data</label>
            <div className="flex gap-4">
              {['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'].map((f) => (
                <label key={f} className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer">
                  <input type="radio" name="datefmt" checked={dateFormat === f} onChange={() => setDateFormat(f)} className="accent-blue-600" />
                  {f}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Formato de hora</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer">
                <input type="radio" name="timefmt" checked={timeFormat === '24h'} onChange={() => setTimeFormat('24h')} className="accent-blue-600" />
                24 horas (14:30)
              </label>
              <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer">
                <input type="radio" name="timefmt" checked={timeFormat === '12h'} onChange={() => setTimeFormat('12h')} className="accent-blue-600" />
                12 horas (2:30 PM)
              </label>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Charset DICOM (Character Set)</label>
            <select className="w-full max-w-sm rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" defaultValue="ISO_IR 192">
              <option>ASCII</option>
              <option>ISO_IR 6</option>
              <option>ISO_IR 100</option>
              <option>ISO_IR 192 (UTF-8)</option>
            </select>
            <p className="text-xs text-gray-500 mt-1">Usado ao decodificar nomes de pacientes com acentos.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Fuso horário</label>
            <select className="w-full max-w-sm rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" defaultValue="America/Sao_Paulo">
              <option>America/Sao_Paulo</option>
              <option>America/Manaus</option>
              <option>America/Fortaleza</option>
              <option>UTC</option>
            </select>
          </div>
        </div>
      </section>

      <div className="flex justify-end">
        <button
          onClick={() => addLog('success', `Localização salva — idioma: ${language}`, 'CONFIG')}
          className="flex items-center gap-1.5 rounded border border-gray-400 bg-gray-100 px-5 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200"
        >
          <Save size={14} /> Salvar
        </button>
      </div>
    </div>
  );
}
