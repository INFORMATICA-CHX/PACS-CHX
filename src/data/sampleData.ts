import type { Patient, Study, Series, ServerConfig, LogEntry, ServerStatus } from '@/types';

const patients: Patient[] = [
  { id: 'p1', patientId: 'PT-100234', patientName: 'SILVA^JOAO^M', birthDate: '1958-03-12', sex: 'M', studyCount: 2 },
  { id: 'p2', patientId: 'PT-100451', patientName: 'OLIVEIRA^MARIA^F', birthDate: '1972-11-04', sex: 'F', studyCount: 1 },
  { id: 'p3', patientId: 'PT-100778', patientName: 'SANTOS^CARLOS^M', birthDate: '1965-07-22', sex: 'M', studyCount: 2 },
  { id: 'p4', patientId: 'PT-100890', patientName: 'COSTA^ANA^F', birthDate: '1989-02-15', sex: 'F', studyCount: 1 },
  { id: 'p5', patientId: 'PT-101102', patientName: 'FERREIRA^PEDRO^M', birthDate: '1978-09-30', sex: 'M', studyCount: 1 },
  { id: 'p6', patientId: 'PT-101345', patientName: 'LIMA^HELENA^F', birthDate: '1991-05-18', sex: 'F', studyCount: 1 },
];

const studies: Study[] = [
  { id: 's1', patientId: 'PT-100234', patientName: 'SILVA^JOAO^M', patientBirthDate: '1958-03-12', patientSex: 'M', studyDate: '2025-07-28', studyTime: '09:14:22', accessionNumber: 'ACC-20250728-001', modality: 'CT', studyDescription: 'TORAX COM CONTRASTE', bodyPartExamined: 'CHEST', seriesCount: 3, imageCount: 120, sourceAeTitle: 'CT_SCANNER_01', institution: 'My Institution', updatedAt: new Date(Date.now() - 3600000).toISOString() },
  { id: 's2', patientId: 'PT-100234', patientName: 'SILVA^JOAO^M', patientBirthDate: '1958-03-12', patientSex: 'M', studyDate: '2025-06-15', studyTime: '11:30:00', accessionNumber: 'ACC-20250615-014', modality: 'CR', studyDescription: 'TORAX PA', bodyPartExamined: 'CHEST', seriesCount: 1, imageCount: 1, sourceAeTitle: 'CR_ROOM_02', institution: 'My Institution', updatedAt: new Date(Date.now() - 86400000 * 43).toISOString() },
  { id: 's3', patientId: 'PT-100451', patientName: 'OLIVEIRA^MARIA^F', patientBirthDate: '1972-11-04', patientSex: 'F', studyDate: '2025-07-26', studyTime: '14:45:10', accessionNumber: 'ACC-20250726-008', modality: 'MR', studyDescription: 'CRANIO SEM CONTRASTE', bodyPartExamined: 'HEAD', seriesCount: 4, imageCount: 88, sourceAeTitle: 'MR_UNIT_01', institution: 'My Institution', updatedAt: new Date(Date.now() - 86400000 * 3).toISOString() },
  { id: 's4', patientId: 'PT-100778', patientName: 'SANTOS^CARLOS^M', patientBirthDate: '1965-07-22', patientSex: 'M', studyDate: '2025-07-27', studyTime: '08:20:33', accessionNumber: 'ACC-20250727-003', modality: 'CT', studyDescription: 'ABDOME COM CONTRASTE', bodyPartExamined: 'ABDOMEN', seriesCount: 2, imageCount: 64, sourceAeTitle: 'CT_SCANNER_01', institution: 'My Institution', updatedAt: new Date(Date.now() - 86400000 * 2).toISOString() },
  { id: 's5', patientId: 'PT-100778', patientName: 'SANTOS^CARLOS^M', patientBirthDate: '1965-07-22', patientSex: 'M', studyDate: '2025-05-10', studyTime: '16:10:00', accessionNumber: 'ACC-20250510-021', modality: 'DX', studyDescription: 'JOELHO DIREITO AP', bodyPartExamined: 'KNEE', seriesCount: 1, imageCount: 2, sourceAeTitle: 'DX_ROOM_03', institution: 'My Institution', updatedAt: new Date(Date.now() - 86400000 * 80).toISOString() },
  { id: 's6', patientId: 'PT-100890', patientName: 'COSTA^ANA^F', patientBirthDate: '1989-02-15', patientSex: 'F', studyDate: '2025-07-29', studyTime: '07:55:00', accessionNumber: 'ACC-20250729-001', modality: 'CT', studyDescription: 'TORAX ALTA RESOLUCAO', bodyPartExamined: 'CHEST', seriesCount: 2, imageCount: 96, sourceAeTitle: 'CT_SCANNER_02', institution: 'My Institution', updatedAt: new Date(Date.now() - 7200000).toISOString() },
  { id: 's7', patientId: 'PT-101102', patientName: 'FERREIRA^PEDRO^M', patientBirthDate: '1978-09-30', patientSex: 'M', studyDate: '2025-07-25', studyTime: '10:00:00', accessionNumber: 'ACC-20250725-005', modality: 'MR', studyDescription: 'COLUNA LOMBAR', bodyPartExamined: 'L-SPINE', seriesCount: 3, imageCount: 72, sourceAeTitle: 'MR_UNIT_01', institution: 'My Institution', updatedAt: new Date(Date.now() - 86400000 * 4).toISOString() },
  { id: 's8', patientId: 'PT-101345', patientName: 'LIMA^HELENA^F', patientBirthDate: '1991-05-18', patientSex: 'F', studyDate: '2025-07-24', studyTime: '13:20:00', accessionNumber: 'ACC-20250724-011', modality: 'CR', studyDescription: 'TORAX PA', bodyPartExamined: 'CHEST', seriesCount: 1, imageCount: 1, sourceAeTitle: 'CR_ROOM_02', institution: 'My Institution', updatedAt: new Date(Date.now() - 86400000 * 5).toISOString() },
];

const series: Series[] = [
  { id: 'se1', studyId: 's1', seriesNumber: 1, modality: 'CT', seriesDescription: 'AXIAL SEM CONTRASTE', bodyPartExamined: 'CHEST', imageCount: 40 },
  { id: 'se2', studyId: 's1', seriesNumber: 2, modality: 'CT', seriesDescription: 'AXIAL COM CONTRASTE', bodyPartExamined: 'CHEST', imageCount: 40 },
  { id: 'se3', studyId: 's1', seriesNumber: 3, modality: 'CT', seriesDescription: 'CORONAL MPR', bodyPartExamined: 'CHEST', imageCount: 40 },
  { id: 'se4', studyId: 's2', seriesNumber: 1, modality: 'CR', seriesDescription: 'PA', bodyPartExamined: 'CHEST', imageCount: 1 },
  { id: 'se5', studyId: 's3', seriesNumber: 1, modality: 'MR', seriesDescription: 'T1 AXIAL', bodyPartExamined: 'HEAD', imageCount: 22 },
  { id: 'se6', studyId: 's3', seriesNumber: 2, modality: 'MR', seriesDescription: 'T2 AXIAL', bodyPartExamined: 'HEAD', imageCount: 22 },
  { id: 'se7', studyId: 's3', seriesNumber: 3, modality: 'MR', seriesDescription: 'FLAIR AXIAL', bodyPartExamined: 'HEAD', imageCount: 22 },
  { id: 'se8', studyId: 's3', seriesNumber: 4, modality: 'MR', seriesDescription: 'T1 SAGITAL', bodyPartExamined: 'HEAD', imageCount: 22 },
  { id: 'se9', studyId: 's4', seriesNumber: 1, modality: 'CT', seriesDescription: 'AXIAL SEM CONTRASTE', bodyPartExamined: 'ABDOMEN', imageCount: 32 },
  { id: 'se10', studyId: 's4', seriesNumber: 2, modality: 'CT', seriesDescription: 'AXIAL COM CONTRASTE', bodyPartExamined: 'ABDOMEN', imageCount: 32 },
  { id: 'se11', studyId: 's5', seriesNumber: 1, modality: 'DX', seriesDescription: 'AP', bodyPartExamined: 'KNEE', imageCount: 2 },
  { id: 'se12', studyId: 's6', seriesNumber: 1, modality: 'CT', seriesDescription: 'AXIAL HR', bodyPartExamined: 'CHEST', imageCount: 48 },
  { id: 'se13', studyId: 's6', seriesNumber: 2, modality: 'CT', seriesDescription: 'CORONAL HR', bodyPartExamined: 'CHEST', imageCount: 48 },
  { id: 'se14', studyId: 's7', seriesNumber: 1, modality: 'MR', seriesDescription: 'T2 SAGITAL', bodyPartExamined: 'L-SPINE', imageCount: 24 },
  { id: 'se15', studyId: 's7', seriesNumber: 2, modality: 'MR', seriesDescription: 'T1 SAGITAL', bodyPartExamined: 'L-SPINE', imageCount: 24 },
  { id: 'se16', studyId: 's7', seriesNumber: 3, modality: 'MR', seriesDescription: 'T2 AXIAL', bodyPartExamined: 'L-SPINE', imageCount: 24 },
  { id: 'se17', studyId: 's8', seriesNumber: 1, modality: 'CR', seriesDescription: 'PA', bodyPartExamined: 'CHEST', imageCount: 1 },
];

export const samplePatients: Patient[] = patients;
export const sampleStudies: Study[] = studies;
export const sampleSeries: Series[] = series;

export const defaultConfig: ServerConfig = {
  aeTitle: 'PACSCHX',
  listenIp: '192.168.3.2',
  listenPort: 11112,
  storagePath: 'C:\\Users\\CHX\\Desktop\\PACS REVISADO\\PACS CHX\\project\\storage',
  dbPath: 'C:\\Users\\CHX\\Desktop\\PACS REVISADO\\PACS CHX\\project\\pacs.db',
  logPath: 'C:\\Users\\CHX\\Desktop\\PACS REVISADO\\PACS CHX\\project\\logs',
  apiPort: 4000,
  viewerUser: 'admin',
  viewerPassword: 'password',
  dicom: { acceptUnknownSources: false },
  remoteDevices: [],
};

export const defaultLogs: LogEntry[] = [
  { id: 'l1', timestamp: new Date(Date.now() - 1000 * 60 * 2).toISOString(), level: 'success', message: 'C-STORE recebido: estudo ACC-20250729-001 (96 imagens) de CT_SCANNER_02', source: 'SCP' },
  { id: 'l2', timestamp: new Date(Date.now() - 1000 * 60 * 8).toISOString(), level: 'info', message: 'C-ECHO respondido para CT_SCANNER_01 (192.168.10.20)', source: 'SCP' },
  { id: 'l3', timestamp: new Date(Date.now() - 1000 * 60 * 15).toISOString(), level: 'warning', message: 'Conexão recusada: AE Title DESCONHECIDO de 10.0.0.55', source: 'SCP' },
  { id: 'l4', timestamp: new Date(Date.now() - 1000 * 60 * 30).toISOString(), level: 'success', message: 'C-STORE recebido: estudo ACC-20250728-001 (120 imagens) de CT_SCANNER_01', source: 'SCP' },
  { id: 'l5', timestamp: new Date(Date.now() - 1000 * 60 * 45).toISOString(), level: 'info', message: 'Servidor SCP iniciado na porta 11112', source: 'SCP' },
];

export const defaultStatus: ServerStatus = {
  running: true,
  startedAt: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
  connectionsToday: 14,
  studiesStored: 8,
  storageUsedGb: 12.4,
};
