// PACS domain types shared across the frontend

export interface Patient {
  id: string;
  patientId: string;
  patientName: string;
  birthDate: string; // YYYY-MM-DD
  sex: 'M' | 'F' | 'O' | '';
  studyCount: number;
}

export interface Study {
  id: string;
  patientId: string;
  patientName: string;
  patientBirthDate: string; // YYYY-MM-DD
  patientSex: 'M' | 'F' | 'O' | '';
  studyDate: string; // YYYY-MM-DD
  studyTime: string; // HH:mm:ss
  accessionNumber: string;
  modality: string;
  studyDescription: string;
  bodyPartExamined: string;
  seriesCount: number;
  imageCount: number;
  sourceAeTitle: string;
  institution: string;
  referringPhysician?: string;
  updatedAt: string; // ISO
}

export interface Series {
  id: string;
  studyId: string;
  seriesNumber: number;
  modality: string;
  seriesDescription: string;
  bodyPartExamined: string;
  imageCount: number;
}

export interface DicomImage {
  width: number;
  height: number;
  pixelData: Float32Array;
  pixelSpacing: number;
  sliceThickness: number;
  windowCenter: number;
  windowWidth: number;
  instanceNumber: number;
  sliceLocation: number;
  photometricInterpretation: 'MONOCHROME1' | 'MONOCHROME2';
}

export interface RemoteDevice {
  id: string;
  kind?: 'node' | 'printer';
  aeTitle: string;
  callingAeTitle?: string;
  ip: string;
  port: number;
  description: string;
  enabled: boolean;
  // Undefined is treated as true (existing devices keep working both ways
  // until an admin narrows their role).
  forPacs?: boolean;
  forWorklist?: boolean;
}

export interface ServerConfig {
  aeTitle: string;
  listenIp: string;
  listenPort: number;
  storagePath: string;
  dbPath: string;
  logPath: string;
  apiPort: number;
  viewerUser: string;
  viewerPassword: string;
  dicom?: {
    acceptUnknownSources?: boolean;
  };
  remoteDevices: RemoteDevice[];
}

export type LogLevel = 'info' | 'warning' | 'error' | 'success';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  source: string;
}

export interface ServerStatus {
  running: boolean;
  startedAt: string | null;
  connectionsToday: number;
  studiesStored: number;
  storageUsedGb: number;
  pid?: number | null;
  lastError?: string | null;
}

export type ViewMode = 'worklist' | 'viewer' | 'settings' | 'status';

export type MeasurementType = 'length' | 'angle' | 'marker' | 'text' | 'none';

export interface Measurement {
  id: string;
  type: MeasurementType;
  points: { x: number; y: number }[];
  value: number | null;
  label: string;
}

export type ConnectionTestState = 'idle' | 'testing' | 'success' | 'failed';

export interface ViewerTab {
  tabId: string;
  study: Study;
  initialSeriesId?: string;
}
