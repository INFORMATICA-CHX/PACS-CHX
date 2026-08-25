import { useCallback, useEffect, useRef, useState } from 'react';
import type { Patient, Study, Series, ServerConfig, LogEntry, ServerStatus } from '@/types';
import {
  defaultConfig,
  defaultLogs,
  defaultStatus,
} from '@/data/sampleData';
import { apiFetch, getClinicalToken } from '@/lib/apiClient';

const STORAGE_KEY = 'pacs_config_v1';
const LOG_KEY = 'pacs_logs_v1';
const STATUS_KEY = 'pacs_status_v1';

function loadConfig(): ServerConfig {
  const fallback = { ...defaultConfig };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const cached = JSON.parse(raw) as Partial<ServerConfig>;
      if (typeof cached.apiPort === 'number') fallback.apiPort = cached.apiPort;
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

function loadLogs(): LogEntry[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (raw) return JSON.parse(raw) as LogEntry[];
  } catch {
    /* ignore */
  }
  return defaultLogs;
}

function loadStatus(): ServerStatus {
  try {
    const raw = localStorage.getItem(STATUS_KEY);
    if (raw) return JSON.parse(raw) as ServerStatus;
  } catch {
    /* ignore */
  }
  return defaultStatus;
}

// Shared data-access layer. Clinical records come from the local PACS API;
// only lightweight workstation preferences remain in localStorage.

export function usePacsStore(options: { loadClinicalData?: boolean } = {}) {
  const loadClinicalData = options.loadClinicalData ?? true;
  const [patients, setPatients] = useState<Patient[]>([]);
  const [studies, setStudies] = useState<Study[]>([]);
  const [series, setSeries] = useState<Series[]>([]);
  const [dataLoading, setDataLoading] = useState(loadClinicalData);
  const [dataError, setDataError] = useState<string | null>(null);
  const [config, setConfigState] = useState<ServerConfig>(loadConfig);
  const [logs, setLogs] = useState<LogEntry[]>(loadLogs);
  const [status, setStatus] = useState<ServerStatus>(loadStatus);
  const studiesRevisionRef = useRef('');

  const refreshData = useCallback(async (options: { silent?: boolean; includePatients?: boolean; includeSeries?: boolean } = {}) => {
    if (!loadClinicalData || !getClinicalToken()) {
      setDataLoading(false);
      return;
    }
    const apiBase = window.location.protocol === 'http:' || window.location.protocol === 'https:'
      ? window.location.origin
      : `http://127.0.0.1:${config.apiPort ?? 4000}`;
    if (!options.silent) setDataLoading(true);
    try {
      const [patientsResponse, studiesResponse, seriesResponse] = await Promise.all([
        options.includePatients ? apiFetch(`${apiBase}/api/patients`) : Promise.resolve(null),
        apiFetch(`${apiBase}/api/studies`),
        options.includeSeries ? apiFetch(`${apiBase}/api/series`) : Promise.resolve(null),
      ]);
      if ((patientsResponse && !patientsResponse.ok) || !studiesResponse.ok || (seriesResponse && !seriesResponse.ok)) {
        const failed = !studiesResponse.ok ? await studiesResponse.json().catch(() => ({})) : {};
        throw new Error(failed.error ?? 'Não foi possível carregar a Worklist.');
      }
      const patientRows = patientsResponse ? await patientsResponse.json() : [];
      const studyRows = await studiesResponse.json();
      const seriesRows = seriesResponse ? await seriesResponse.json() : [];
      const mappedPatients: Patient[] = patientRows.map((row: Record<string, unknown>) => ({
        id: String(row.id), patientId: String(row.patient_id ?? ''), patientName: String(row.patient_name ?? ''),
        birthDate: dicomDate(String(row.birth_date ?? '')), sex: String(row.sex ?? '') as Patient['sex'], studyCount: Number(row.study_count ?? 0),
      }));
      const mappedStudies: Study[] = studyRows.map((row: Record<string, unknown>) => ({
        id: String(row.id), patientId: String(row.patient_id ?? ''), patientName: String(row.patient_name ?? ''),
        patientBirthDate: dicomDate(String(row.birth_date ?? '')), patientSex: String(row.sex ?? '') as Study['patientSex'],
        studyDate: dicomDate(String(row.study_date ?? '')), studyTime: dicomTime(String(row.study_time ?? '')),
        accessionNumber: String(row.accession_number ?? ''), modality: String(row.modality ?? ''),
        studyDescription: String(row.study_description ?? ''), bodyPartExamined: String(row.body_part_examined ?? ''),
        seriesCount: Number(row.series_count ?? 0), imageCount: Number(row.image_count ?? 0),
        sourceAeTitle: String(row.source_ae_title ?? ''), institution: String(row.institution_name ?? ''),
        referringPhysician: String(row.referring_physician ?? ''), updatedAt: String(row.received_at ?? ''),
      }));
      const mappedSeries: Series[] = seriesRows.map((row: Record<string, unknown>): Series => ({
        id: String(row.id), studyId: String(row.study_id ?? ''), seriesNumber: Number(row.series_number ?? 0),
        modality: String(row.modality ?? ''), seriesDescription: String(row.series_description ?? ''),
        bodyPartExamined: String(row.body_part_examined ?? ''), imageCount: Number(row.image_count ?? 0),
      }));
      if (patientsResponse) setPatients(mappedPatients);
      setStudies(mappedStudies);
      if (seriesResponse) setSeries(mappedSeries);
      setDataError(null);
    } catch (error) {
      setDataError(error instanceof Error ? error.message : 'Erro ao carregar a Worklist.');
    } finally { if (!options.silent) setDataLoading(false); }
  }, [config.apiPort, loadClinicalData]);

  useEffect(() => {
    const apiBase = `http://127.0.0.1:${config.apiPort ?? 4000}`;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const loadServerConfig = () => {
      attempts += 1;
      fetch(`${apiBase}/api/config`)
        .then(async (response) => {
          if (!response.ok) throw new Error('Config unavailable');
          return await response.json() as ServerConfig;
        })
        .then((serverConfig) => {
          if (!cancelled) setConfigState((current) => ({ ...current, ...serverConfig }));
        })
        .catch(() => {
          if (!cancelled && attempts < 20) {
            timer = setTimeout(loadServerConfig, 500);
          }
        });
    };

    loadServerConfig();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [config.apiPort]);

  useEffect(() => {
    if (!loadClinicalData) {
      setDataLoading(false);
      return;
    }
    void refreshData();
    let checking = false;
    const revisionKey = (payload: { studyCount?: number; lastStudyId?: number; lastReceivedAt?: string }) =>
      `${payload.studyCount ?? 0}:${payload.lastStudyId ?? 0}:${payload.lastReceivedAt ?? ''}`;
    const checkForNewStudies = async () => {
      if (checking || !loadClinicalData || !getClinicalToken() || document.visibilityState !== 'visible') return;
      checking = true;
      try {
        const apiBase = window.location.protocol === 'http:' || window.location.protocol === 'https:'
          ? window.location.origin
          : `http://127.0.0.1:${config.apiPort ?? 4000}`;
        const response = await apiFetch(`${apiBase}/api/studies/revision`);
        if (!response.ok) return;
        const revision = revisionKey(await response.json());
        if (!studiesRevisionRef.current) {
          studiesRevisionRef.current = revision;
          return;
        }
        if (revision !== studiesRevisionRef.current) {
          studiesRevisionRef.current = revision;
          void refreshData({ silent: true, includePatients: true });
        }
      } catch {
        /* keep current data if the heartbeat fails briefly */
      } finally {
        checking = false;
      }
    };
    void checkForNewStudies();
    const timer = window.setInterval(() => {
      void checkForNewStudies();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [config.apiPort, refreshData, loadClinicalData]);

  // Keep only the API port cached so the UI can find a server after a port change.
  // Runtime server settings are loaded from /api/config and persisted to server/config.json.
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ apiPort: config.apiPort }));
  }, [config.apiPort]);

  useEffect(() => {
    localStorage.setItem(LOG_KEY, JSON.stringify(logs.slice(0, 200)));
  }, [logs]);

  useEffect(() => {
    localStorage.setItem(STATUS_KEY, JSON.stringify(status));
  }, [status]);

  const setConfig = useCallback((next: ServerConfig) => {
    setConfigState(next);
  }, []);

  const addLog = useCallback((level: LogEntry['level'], message: string, source = 'UI') => {
    const entry: LogEntry = {
      id: `l${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      level,
      message,
      source,
    };
    setLogs((prev) => [entry, ...prev].slice(0, 200));
  }, []);

  const toggleServer = useCallback(() => {
    setStatus((prev) => {
      if (prev.running) {
        addLog('warning', 'Servidor SCP parado pelo operador', 'SCP');
        return { ...prev, running: false, startedAt: null };
      }
      addLog('success', 'Servidor SCP iniciado', 'SCP');
      return { ...prev, running: true, startedAt: new Date().toISOString() };
    });
  }, [addLog]);

  const setServerRunning = useCallback((running: boolean) => {
    setStatus((prev) => prev.running === running ? prev : {
      ...prev,
      running,
      startedAt: running ? new Date().toISOString() : null,
    });
  }, []);

  const setServerProcessStatus = useCallback((processStatus: { running: boolean; pid: number | null; startedAt: string | null; lastError: string | null }) => {
    setStatus((prev) => ({
      ...prev,
      running: processStatus.running,
      pid: processStatus.pid,
      startedAt: processStatus.startedAt,
      lastError: processStatus.lastError,
    }));
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  const recordReceivedStudy = useCallback((source: string, imageCount: number) => {
    const safeImageCount = Math.max(1, Math.round(imageCount));
    setStatus((prev) => ({
      ...prev,
      connectionsToday: prev.connectionsToday + 1,
      studiesStored: prev.studiesStored + 1,
      storageUsedGb: Number((prev.storageUsedGb + safeImageCount * 0.018).toFixed(2)),
    }));
    addLog('success', `C-STORE recebido de ${source}: ${safeImageCount} imagem(ns) indexadas`, 'SCP');
  }, [addLog]);

  return {
    patients,
    studies,
    series,
    config,
    setConfig,
    logs,
    addLog,
    clearLogs,
    recordReceivedStudy,
    status,
    toggleServer,
    setServerRunning,
    setServerProcessStatus,
    dataLoading,
    dataError,
    refreshData,
  };
}

export type PacsStore = ReturnType<typeof usePacsStore>;

function dicomDate(value: string) {
  const digits = value.replace(/[^0-9]/g, '');
  return digits.length >= 8 ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` : value;
}
function dicomTime(value: string) {
  const digits = value.replace(/[^0-9]/g, '');
  return digits.length >= 4 ? `${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4, 6) || '00'}` : value;
}


