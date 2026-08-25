import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import dcmjs from 'dcmjs';
import { loadConfig } from '../src/config.js';
import { initDb } from '../src/database.js';
import { Logger } from '../src/logger.js';
import { DicomScp } from '../src/dicomScp.js';

const { DicomDict, DicomMetaDictionary } = dcmjs.data;
const UID_ROOT = '1.2.826.0.1.3680043.10.9876';
const CT_STORAGE = '1.2.840.10008.5.1.4.1.1.2';
const MR_STORAGE = '1.2.840.10008.5.1.4.1.1.4';
const CR_STORAGE = '1.2.840.10008.5.1.4.1.1.1';

const demos = [
  { id: 'CHX-DEMO-001', name: 'ANA^SILVA', birth: '19870514', sex: 'F', date: '20260731', modality: 'CT', description: 'TC DE TORAX', series: 'TORAX SEM CONTRASTE', body: 'CHEST', count: 24, seed: 11 },
  { id: 'CHX-DEMO-002', name: 'CARLOS^MENDES', birth: '19691203', sex: 'M', date: '20260730', modality: 'MR', description: 'RM DE CRANIO', series: 'AXIAL T2 FLAIR', body: 'HEAD', count: 20, seed: 22 },
  { id: 'CHX-DEMO-003', name: 'MARIA^OLIVEIRA', birth: '19940221', sex: 'F', date: '20260729', modality: 'CR', description: 'RADIOGRAFIA DE TORAX PA', series: 'TORAX PA', body: 'CHEST', count: 1, seed: 33 },
  { id: 'CHX-DEMO-004', name: 'JOAO^COSTA', birth: '19780809', sex: 'M', date: '20260728', modality: 'CT', description: 'TC DE ABDOME TOTAL', series: 'ABDOME PORTAL', body: 'ABDOMEN', count: 18, seed: 44 },
  { id: 'CHX-DEMO-005', name: 'LUCIA^FERREIRA', birth: '19551126', sex: 'F', date: '20260727', modality: 'MR', description: 'RM DE JOELHO DIREITO', series: 'SAGITAL PD FAT SAT', body: 'KNEE', count: 16, seed: 55 },
];

function pixelsFor(demo, slice, size = 256) {
  const pixels = new Uint16Array(size * size);
  const phase = (slice / Math.max(demo.count - 1, 1) - 0.5) * 0.55;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = (x - size / 2) / (size / 2);
      const ny = (y - size / 2) / (size / 2);
      const r = Math.sqrt(nx * nx + ny * ny);
      const anatomy = r < 0.88 ? 520 + (1 - r) * 720 : 32;
      const organ1 = Math.hypot(nx + 0.28, ny + phase) < 0.31 ? 1050 : 0;
      const organ2 = Math.hypot(nx - 0.28, ny - phase) < 0.29 ? 880 : 0;
      const spine = Math.hypot(nx, ny - 0.42) < 0.10 ? 1350 : 0;
      const wave = 70 * Math.sin(x * 0.12 + demo.seed) * Math.cos(y * 0.09 + slice);
      pixels[y * size + x] = Math.max(0, Math.min(4095, Math.round(anatomy + organ1 + organ2 + spine + wave)));
    }
  }
  return pixels;
}

function dicomBuffer(demo, patientIndex, instance) {
  const studyUid = `${UID_ROOT}.1.${patientIndex}`;
  const seriesUid = `${UID_ROOT}.2.${patientIndex}.1`;
  const sopUid = `${UID_ROOT}.3.${patientIndex}.${instance}`;
  const storageClass = demo.modality === 'MR' ? MR_STORAGE : demo.modality === 'CR' ? CR_STORAGE : CT_STORAGE;
  const version = new Uint8Array([0, 1]);
  const meta = {
    '00020001': { vr: 'OB', Value: [version.buffer] },
    '00020002': { vr: 'UI', Value: [storageClass] },
    '00020003': { vr: 'UI', Value: [sopUid] },
    '00020010': { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] },
    '00020012': { vr: 'UI', Value: [`${UID_ROOT}.9`] },
    '00020013': { vr: 'SH', Value: ['CHX_DEMO_1'] },
  };
  const pixelData = pixelsFor(demo, instance - 1);
  const dataset = {
    SOPClassUID: storageClass, SOPInstanceUID: sopUid,
    StudyInstanceUID: studyUid, SeriesInstanceUID: seriesUid,
    PatientID: demo.id, PatientName: demo.name, PatientBirthDate: demo.birth, PatientSex: demo.sex,
    StudyDate: demo.date, StudyTime: '093000', AccessionNumber: `DEMO-${String(patientIndex).padStart(3, '0')}`,
    Modality: demo.modality, StudyDescription: demo.description, SeriesDescription: demo.series,
    BodyPartExamined: demo.body, SeriesNumber: 1, InstanceNumber: instance,
    Rows: 256, Columns: 256, SamplesPerPixel: 1, PhotometricInterpretation: 'MONOCHROME2',
    BitsAllocated: 16, BitsStored: 12, HighBit: 11, PixelRepresentation: 0,
    WindowCenter: 900, WindowWidth: 1800, PixelSpacing: [0.8, 0.8], SliceThickness: 2.5,
    ImagePositionPatient: [0, 0, instance * 2.5], ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    Manufacturer: 'CHX Medical Systems', InstitutionName: 'CHX Demo Hospital',
    ReferringPhysicianName: 'MEDICO^DEMONSTRACAO', StationAETitle: 'CHX_DEMO',
    PixelData: [pixelData.buffer], _vrMap: { PixelData: 'OW' },
  };
  const dict = new DicomDict(meta);
  dict.dict = DicomMetaDictionary.denaturalizeDataset(dataset);
  return Buffer.from(dict.write());
}

const config = loadConfig();
const db = initDb(config.dbPath);
const logger = new Logger(config.logPath);
const scp = new DicomScp(config, db, logger);
const staging = join(config.storagePath, '.demo-staging');
mkdirSync(staging, { recursive: true });

let imported = 0;
try {
  demos.forEach((demo, index) => {
    for (let instance = 1; instance <= demo.count; instance += 1) {
      const source = join(staging, `${demo.id}-${String(instance).padStart(3, '0')}.dcm`);
      writeFileSync(source, dicomBuffer(demo, index + 1, instance));
      scp.importFile(source);
      imported += 1;
    }
  });
} finally {
  rmSync(staging, { recursive: true, force: true });
  db.close();
}

console.log(`CHX demo concluido: ${demos.length} pacientes, ${imported} imagens DICOM.`);
