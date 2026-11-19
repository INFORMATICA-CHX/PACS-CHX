// SQLite metadata index for DICOM studies.
// Stores parsed DICOM metadata so the worklist loads instantly
// without re-parsing every .dcm file.

import { existsSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3-multiple-ciphers';
import { keyAsHex, loadDataKey } from './dataProtection.js';

function isPlaintextDatabase(dbPath) {
  if (!existsSync(dbPath)) return false;
  return readFileSync(dbPath).subarray(0, 16).toString('ascii') === 'SQLite format 3\0';
}

function openEncryptedDatabase(dbPath, keyHex) {
  const db = new Database(dbPath);
  db.pragma("cipher='sqlcipher'");
  db.pragma('legacy=4');
  db.pragma(`key="x'${keyHex}'"`);
  db.prepare('SELECT count(*) FROM sqlite_master').get();
  return db;
}

const KONICA_PROJECTIONS = {
  '0000/0100': ['ESCAFOIDE', 'OBL'], '0010': ['FRONTAL AP', 'AP'], '0011': ['FRONTAL AP', 'AP'],
  '0012': ['FRONTAL PA', 'PA'], '0013': ['LATERAL', 'LAT'], '0014': ['LATERAL DIREITA', 'LAT'],
  '0015': ['LATERAL ESQUERDA', 'LAT'], '0016': ['OBLIQUA', 'OBL'], '0017': ['OBLIQUA DIREITA', 'OBL'],
  '0018': ['OBLIQUA ESQUERDA', 'OBL'], '0021': ['AXIAL', 'AXIAL'], '0022': ['OBLIQUA', 'OBL'],
  '0024': ['DECUBITO', 'DECUBITUS'], '0030': ['LORDOTICA', 'AP'], '0034': ['TOWNE', 'AP'],
  '0036': ['WATERS', 'PA'], '0037': ['CALDWELL', 'PA'], '0042': ['RHESE', 'OBL'],
  '0047': ['Y ESCAPULAR', 'LAT'], '5400': ['FLEXAO', 'LAT'], '5500': ['EXTENSAO', 'LAT'],
  '5600': ['FRONTAL AP PEDIATRICA', 'AP'], '5700': ['PERFIL RA', 'LAT'], '5800': ['TRANSORAL ODONTOIDE', 'AP'],
  '7100': ['ROTACAO INTERNA', 'AP'], '7300': ['ROTACAO EXTERNA', 'AP'],
};

function konicaProjection(protocolCode) {
  const code = String(protocolCode || '').trim();
  if (!/^\d{16}$/.test(code)) return { name: 'PROJECAO ESPECIAL', view: '', encodedSide: '' };
  const viewKey = code.slice(8, 12);
  const tail = code.slice(12, 16);
  if (viewKey === '7000') return { name: tail === '0001' ? 'ARTICULACAO AC COM CARGA' : 'ARTICULACAO AC SEM CARGA', view: 'AP', encodedSide: '' };
  const rule = KONICA_PROJECTIONS[`${viewKey}/${tail}`] || KONICA_PROJECTIONS[viewKey] || [`PROJECAO ${viewKey}`, ''];
  return { name: rule[0], view: rule[1], encodedSide: tail === '0001' ? 'R' : tail === '0002' ? 'L' : '' };
}

function renameKonicaIncidents(db) {
  const rows = db.prepare(`SELECT i.* FROM worklist_exam_incidents i
    JOIN worklist_mapped_exams m ON m.ris_code=i.ris_code
    WHERE lower(m.source_name) LIKE '%konica%' ORDER BY i.ris_code,i.sort_order,i.id`).all();
  if (!rows.length) return;
  const sideSets = new Map();
  const usedByUnsidedExam = new Set();
  rows.forEach((row) => {
    const side = row.ris_code.endsWith('L') ? 'L' : row.ris_code.endsWith('R') ? 'R' : '';
    if (!side) { usedByUnsidedExam.add(row.protocol_code); return; }
    const sides = sideSets.get(row.protocol_code) || new Set();
    sides.add(side); sideSets.set(row.protocol_code, sides);
  });
  const knownSide = new Map();
  sideSets.forEach((sides, code) => { if (sides.size === 1 && !usedByUnsidedExam.has(code)) knownSide.set(code, [...sides][0]); });
  const byRis = new Map();
  rows.forEach((row) => byRis.set(row.ris_code, [...(byRis.get(row.ris_code) || []), row]));
  const update = db.prepare(`UPDATE worklist_exam_incidents SET description=?,code_meaning=?,view_position=?,laterality=?,updated_at=datetime('now') WHERE id=?`);
  db.transaction(() => byRis.forEach((incidents, risCode) => {
    const risSide = risCode.endsWith('L') ? 'L' : risCode.endsWith('R') ? 'R' : '';
    const prepared = incidents.map((row) => {
      const projection = konicaProjection(row.protocol_code);
      return { row, projection, side: risSide || knownSide.get(row.protocol_code) || projection.encodedSide };
    });
    const totals = new Map();
    prepared.forEach((item) => { const key = `${item.row.protocol_code}|${item.projection.name}|${item.side}`; totals.set(key, (totals.get(key) || 0) + 1); });
    const seen = new Map();
    prepared.forEach((item) => {
      const key = `${item.row.protocol_code}|${item.projection.name}|${item.side}`;
      const occurrence = (seen.get(key) || 0) + 1; seen.set(key, occurrence);
      let side = item.side;
      if (!side && totals.get(key) === 2) side = occurrence === 1 ? 'R' : 'L';
      const sideName = side === 'L' ? 'ESQUERDA' : side === 'R' ? 'DIREITA' : '';
      const alreadySided = /\b(DIREITA|ESQUERDA)$/.test(item.projection.name);
      const name = sideName && !alreadySided ? `${item.projection.name} ${sideName}` : item.projection.name;
      update.run(name, name, item.projection.view, side, item.row.id);
    });
  }))();
}

export function initDb(dbPath) {
  const keyHex = keyAsHex(loadDataKey());
  let db;

  if (isPlaintextDatabase(dbPath)) {
    if (process.env.PACS_DB_ALLOW_PLAINTEXT_MIGRATION !== '1') {
      throw new Error('Banco SQLite ainda esta em texto puro. Crie um backup e inicie uma vez com PACS_DB_ALLOW_PLAINTEXT_MIGRATION=1.');
    }
    db = new Database(dbPath);
    db.pragma('journal_mode = DELETE');
    db.pragma("cipher='sqlcipher'");
    db.pragma('legacy=4');
    db.pragma(`rekey="x'${keyHex}'"`);
    db.close();
  }

  db = openEncryptedDatabase(dbPath, keyHex);
  db.exec('PRAGMA journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id TEXT UNIQUE,
      patient_name TEXT,
      birth_date TEXT,
      sex TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS studies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      study_instance_uid TEXT UNIQUE,
      patient_id INTEGER REFERENCES patients(id),
      accession_number TEXT,
      study_date TEXT,
      study_time TEXT,
      modality TEXT,
      study_description TEXT,
      source_ae_title TEXT,
      series_count INTEGER DEFAULT 0,
      image_count INTEGER DEFAULT 0,
      storage_path TEXT,
      received_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series_instance_uid TEXT UNIQUE,
      study_id INTEGER REFERENCES studies(id),
      series_number INTEGER,
      modality TEXT,
      series_description TEXT,
      body_part_examined TEXT,
      image_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sop_instance_uid TEXT UNIQUE,
      series_id INTEGER REFERENCES series(id),
      instance_number INTEGER,
      file_path TEXT,
      pixel_cache_path TEXT,
      width INTEGER,
      height INTEGER
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      totp_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      study_id INTEGER UNIQUE NOT NULL REFERENCES studies(id),
      status TEXT NOT NULL DEFAULT 'draft',
      current_version INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      signed_by INTEGER REFERENCES users(id),
      signed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS report_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL REFERENCES reports(id),
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      author_id INTEGER REFERENCES users(id),
      content_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(report_id, version)
    );

    CREATE TABLE IF NOT EXISTS report_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      modality TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS print_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      study_id INTEGER NOT NULL REFERENCES studies(id),
      requested_by INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'queued',
      copies INTEGER NOT NULL DEFAULT 1,
      printer_name TEXT,
      error_message TEXT,
      requested_at TEXT DEFAULT (datetime('now')),
      printed_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      actor TEXT NOT NULL,
      role TEXT,
      action TEXT NOT NULL,
      resource TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      previous_hash TEXT NOT NULL,
      event_hash TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backup_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      destination TEXT,
      bytes_written INTEGER DEFAULT 0,
      checksum TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS modality_worklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id TEXT NOT NULL,
      patient_name TEXT NOT NULL,
      birth_date TEXT,
      sex TEXT,
      accession_number TEXT UNIQUE NOT NULL,
      modality TEXT NOT NULL,
      requested_procedure TEXT,
      scheduled_date TEXT NOT NULL,
      scheduled_time TEXT,
      referring_physician TEXT,
      target_devices TEXT,
      sent_devices TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS worklist_modalities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dicom_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      required_rules TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS worklist_mapped_exams (
      ris_code TEXT PRIMARY KEY,
      received_description TEXT NOT NULL DEFAULT '',
      modality_id INTEGER NOT NULL REFERENCES worklist_modalities(id),
      source_name TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS worklist_exam_incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ris_code TEXT NOT NULL REFERENCES worklist_mapped_exams(ris_code) ON UPDATE CASCADE ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 1,
      description TEXT NOT NULL,
      protocol_code TEXT NOT NULL DEFAULT '',
      coding_scheme TEXT NOT NULL DEFAULT '99PACSCHX',
      code_meaning TEXT NOT NULL DEFAULT '',
      body_part TEXT NOT NULL DEFAULT '',
      view_position TEXT NOT NULL DEFAULT '',
      laterality TEXT NOT NULL DEFAULT '',
      observation TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS worklist_unmapped_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ris_code TEXT NOT NULL,
      received_description TEXT NOT NULL DEFAULT '',
      request_payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      mapped_at TEXT,
      released_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS worklist_compatibility_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      delivery_mode TEXT NOT NULL DEFAULT 'one_per_incidence',
      menu_field TEXT NOT NULL DEFAULT 'scheduled_protocol_code',
      send_body_part INTEGER NOT NULL DEFAULT 1,
      send_view_position INTEGER NOT NULL DEFAULT 1,
      charset TEXT NOT NULL DEFAULT 'ISO_IR 192',
      remove_accents INTEGER NOT NULL DEFAULT 0,
      field_limits TEXT NOT NULL DEFAULT '{}',
      accession_suffix INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS worklist_equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      ae_title TEXT UNIQUE NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      brand TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      modality_id INTEGER REFERENCES worklist_modalities(id),
      room_unit TEXT NOT NULL DEFAULT '',
      profile_id INTEGER NOT NULL REFERENCES worklist_compatibility_profiles(id),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS worklist_equipment_incident_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incidence_id INTEGER NOT NULL REFERENCES worklist_exam_incidents(id),
      profile_id INTEGER REFERENCES worklist_compatibility_profiles(id),
      equipment_id INTEGER REFERENCES worklist_equipment(id),
      protocol_code TEXT NOT NULL,
      coding_scheme TEXT NOT NULL DEFAULT '99PACSCHX',
      code_meaning TEXT NOT NULL DEFAULT '',
      UNIQUE(incidence_id, profile_id, equipment_id)
    );

    CREATE TABLE IF NOT EXISTS worklist_find_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_ae TEXT NOT NULL,
      source_ip TEXT NOT NULL,
      equipment_id INTEGER,
      filters TEXT NOT NULL DEFAULT '{}',
      returned_count INTEGER NOT NULL DEFAULT 0,
      returned_tags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'accepted',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_studies_patient ON studies(patient_id);
    CREATE INDEX IF NOT EXISTS idx_series_study ON series(study_id);
    CREATE INDEX IF NOT EXISTS idx_instances_series ON instances(series_id);
    CREATE INDEX IF NOT EXISTS idx_reports_study ON reports(study_id);
    CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_modality_worklist_date ON modality_worklist(scheduled_date, scheduled_time);
    CREATE INDEX IF NOT EXISTS idx_modality_worklist_status ON modality_worklist(status);
    CREATE INDEX IF NOT EXISTS idx_worklist_incidents_ris ON worklist_exam_incidents(ris_code, sort_order);
    CREATE INDEX IF NOT EXISTS idx_worklist_unmapped_status ON worklist_unmapped_queue(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_worklist_find_logs_created ON worklist_find_logs(created_at DESC);

    -- The worklist query (GET /api/studies) filters by modality, source AE
    -- title and study_date, and always sorts by study_date/study_time. Without
    -- these, SQLite has to scan every row in the studies table on every load
    -- and on every 15s poll; the scan gets slower as more exams are received.
    CREATE INDEX IF NOT EXISTS idx_studies_date_time ON studies(study_date DESC, study_time DESC);
    CREATE INDEX IF NOT EXISTS idx_studies_modality ON studies(modality);
    CREATE INDEX IF NOT EXISTS idx_studies_source_ae ON studies(source_ae_title);
    CREATE INDEX IF NOT EXISTS idx_studies_accession ON studies(accession_number);
    -- GET /api/patients sorts by patient_name and GET /api/studies searches
    -- patient_name/patient_id.
    CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(patient_name);
    CREATE INDEX IF NOT EXISTS idx_patients_patient_id ON patients(patient_id);
  `);

  // Additive migrations for databases created by older PACS CHX versions.
  for (const sql of [
    'ALTER TABLE studies ADD COLUMN institution_name TEXT DEFAULT \'\'',
    'ALTER TABLE studies ADD COLUMN referring_physician TEXT DEFAULT \'\'',
    'ALTER TABLE users ADD COLUMN totp_secret TEXT',
    'ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE instances ADD COLUMN pixel_cache_path TEXT',
    'ALTER TABLE modality_worklist ADD COLUMN ris_code TEXT DEFAULT \'\'',
    'ALTER TABLE modality_worklist ADD COLUMN incidence_id INTEGER',
    'ALTER TABLE modality_worklist ADD COLUMN requested_procedure_code TEXT DEFAULT \'\'',
    'ALTER TABLE modality_worklist ADD COLUMN coding_scheme TEXT DEFAULT \'\'',
    'ALTER TABLE modality_worklist ADD COLUMN code_meaning TEXT DEFAULT \'\'',
    'ALTER TABLE modality_worklist ADD COLUMN body_part TEXT DEFAULT \'\'',
    'ALTER TABLE modality_worklist ADD COLUMN view_position TEXT DEFAULT \'\'',
    'ALTER TABLE modality_worklist ADD COLUMN laterality TEXT DEFAULT \'\'',
    'ALTER TABLE modality_worklist ADD COLUMN contrast_flag INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE worklist_mapped_exams ADD COLUMN source_name TEXT NOT NULL DEFAULT \'\'',
  ]) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  // The CS-7 base contains two menu programs for RIS 71020 (CHEST): frontal
  // and lateral. Older/manual registrations stored only the RIS code itself,
  // so patient demographics arrived but CS-7 could not resolve the anatomy
  // program. Repair this one known mapping without touching other exams.
  const konicaChest = db.prepare(`SELECT * FROM worklist_mapped_exams
    WHERE ris_code='71020' AND (lower(source_name) LIKE '%konica%' OR upper(received_description)='TORAX' OR lower(received_description) LIKE '%chest%')`).get();
  if (konicaChest) {
    db.transaction(() => {
      db.prepare("UPDATE worklist_mapped_exams SET received_description='TORAX',source_name='Mapeamento base Konica',updated_at=datetime('now') WHERE ris_code='71020'").run();
      const current = db.prepare("SELECT * FROM worklist_exam_incidents WHERE ris_code='71020' ORDER BY sort_order,id").all();
      const expected = [
        { order: 1, description: 'TORAX FRONTAL', protocol: '1003202000120000', meaning: 'TORAX FRONTAL', view: 'PA' },
        { order: 2, description: 'TORAX LATERAL', protocol: '1003202000130000', meaning: 'TORAX LATERAL', view: 'LAT' },
      ];
      expected.forEach((value, index) => {
        const existing = current[index];
        if (existing) {
          db.prepare(`UPDATE worklist_exam_incidents SET sort_order=?,description=?,protocol_code=?,coding_scheme='99KONICA',code_meaning=?,body_part='CHEST',view_position=?,laterality='',observation='Mapeamento oficial CS-7 Konica',updated_at=datetime('now') WHERE id=?`)
            .run(value.order, value.description, value.protocol, value.meaning, value.view, existing.id);
        } else {
          db.prepare(`INSERT INTO worklist_exam_incidents (ris_code,sort_order,description,protocol_code,coding_scheme,code_meaning,body_part,view_position,laterality,observation) VALUES ('71020',?,?,?,'99KONICA',?,'CHEST',?,'','Mapeamento oficial CS-7 Konica')`)
            .run(value.order, value.description, value.protocol, value.meaning, value.view);
        }
      });
      current.slice(2).forEach((row) => db.prepare('DELETE FROM worklist_exam_incidents WHERE id=?').run(row.id));
    })();
  }

  // Replace the former generic labels ("Incidencia 1", "Incidencia 2"...)
  // with the projection encoded in each original CS-7 protocol. Protocol
  // codes are intentionally left untouched because they are the menu keys
  // consumed by the Konica console.
  renameKonicaIncidents(db);

  const modalityCount = Number(db.prepare('SELECT COUNT(*) AS count FROM worklist_modalities').get().count);
  if (modalityCount === 0) {
    const insertModality = db.prepare('INSERT INTO worklist_modalities (dicom_code, name, required_rules) VALUES (?, ?, ?)');
    for (const [code, name, rules] of [
      ['CR', 'Radiografia computadorizada', { body_part: true, view_position: true }],
      ['DX', 'Radiografia digital', { body_part: true, view_position: true }],
      ['MG', 'Mamografia', { body_part: true, laterality: true }],
      ['CT', 'Tomografia computadorizada', { protocol: true, body_part: true, contrast_flag: true, view_position: false }],
      ['MR', 'Ressonancia magnetica', { protocol: true, body_part: true }],
      ['US', 'Ultrassonografia', {}],
      ['XA', 'Angiografia', { body_part: true }],
    ]) insertModality.run(code, name, JSON.stringify(rules));
  }

  const profileCount = Number(db.prepare('SELECT COUNT(*) AS count FROM worklist_compatibility_profiles').get().count);
  if (profileCount === 0) {
    const insertProfile = db.prepare('INSERT INTO worklist_compatibility_profiles (name,delivery_mode,menu_field,send_body_part,send_view_position,charset,remove_accents,field_limits,accession_suffix) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const profile of [
      ['DICOM generico', 'one_per_incidence', 'scheduled_protocol_code', 1, 1, 'ISO_IR 192', 0, {}, 1],
      ['Fujifilm FCR', 'one_per_incidence', 'scheduled_protocol_code', 1, 1, 'ISO_IR 100', 0, {}, 1],
      ['Carestream CR', 'one_per_incidence', 'step_description', 1, 1, 'ISO_IR 100', 0, {}, 1],
      ['Agfa', 'one_per_incidence', 'requested_procedure_code', 1, 1, 'ISO_IR 100', 0, {}, 1],
      ['Konica', 'one_per_incidence', 'scheduled_protocol_code', 1, 1, 'ISO_IR 100', 0, {}, 1],
      ['TC generico', 'one_per_incidence', 'scheduled_protocol_code', 1, 0, 'ISO_IR 192', 0, {}, 1],
    ]) insertProfile.run(...profile.slice(0, 7), JSON.stringify(profile[7]), profile[8]);
  }

  const templateCount = Number(db.prepare('SELECT COUNT(*) AS count FROM report_templates').get().count);
  if (templateCount === 0) {
    const insert = db.prepare('INSERT INTO report_templates (modality, name, content) VALUES (?, ?, ?)');
    const templates = [
      ['MG', 'Mamografia', 'MAMOGRAFIA\n\nINDICAÇÃO CLÍNICA:\n{{INDICACAO}}\n\nTÉCNICA:\nExame mamográfico bilateral nas incidências craniocaudal e mediolateral oblíqua.\n\nCOMPOSIÇÃO MAMÁRIA:\n\nACHADOS:\n\nCOMPARAÇÃO COM EXAMES ANTERIORES:\n\nIMPRESSÃO DIAGNÓSTICA:\n\nCATEGORIA BI-RADS®:\n\nRECOMENDAÇÃO:'],
      ['CT', 'Tomografia Computadorizada', 'TOMOGRAFIA COMPUTADORIZADA — {{DESCRICAO_EXAME}}\n\nINDICAÇÃO CLÍNICA:\n{{INDICACAO}}\n\nTÉCNICA:\nAquisição volumétrica conforme protocolo do serviço.\n\nACHADOS:\n\nCONCLUSÃO:'],
      ['MR', 'Ressonância Magnética', 'RESSONÂNCIA MAGNÉTICA — {{DESCRICAO_EXAME}}\n\nINDICAÇÃO CLÍNICA:\n{{INDICACAO}}\n\nTÉCNICA:\nSequências multiplanares conforme protocolo do serviço.\n\nACHADOS:\n\nCONCLUSÃO:'],
      ['XR', 'Radiografia', 'RADIOGRAFIA — {{DESCRICAO_EXAME}}\n\nINDICAÇÃO CLÍNICA:\n{{INDICACAO}}\n\nTÉCNICA:\nIncidências realizadas conforme protocolo.\n\nACHADOS:\n\nCONCLUSÃO:'],
      ['CR', 'Radiografia Computadorizada', 'RADIOGRAFIA — {{DESCRICAO_EXAME}}\n\nINDICAÇÃO CLÍNICA:\n{{INDICACAO}}\n\nTÉCNICA:\nIncidências realizadas conforme protocolo.\n\nACHADOS:\n\nCONCLUSÃO:'],
      ['DX', 'Radiografia Digital', 'RADIOGRAFIA DIGITAL — {{DESCRICAO_EXAME}}\n\nINDICAÇÃO CLÍNICA:\n{{INDICACAO}}\n\nTÉCNICA:\nIncidências realizadas conforme protocolo.\n\nACHADOS:\n\nCONCLUSÃO:'],
      ['US', 'Ultrassonografia', 'ULTRASSONOGRAFIA — {{DESCRICAO_EXAME}}\n\nINDICAÇÃO CLÍNICA:\n{{INDICACAO}}\n\nTÉCNICA:\nExame realizado com transdutor apropriado.\n\nACHADOS:\n\nCONCLUSÃO:'],
      ['NM', 'Medicina Nuclear', 'MEDICINA NUCLEAR — {{DESCRICAO_EXAME}}\n\nINDICAÇÃO CLÍNICA:\n{{INDICACAO}}\n\nRADIOFÁRMACO / ATIVIDADE:\n\nTÉCNICA:\n\nACHADOS:\n\nCONCLUSÃO:'],
      ['PT', 'PET/CT', 'PET/CT — {{DESCRICAO_EXAME}}\n\nINDICAÇÃO CLÍNICA:\n{{INDICACAO}}\n\nRADIOFÁRMACO / ATIVIDADE:\n\nTÉCNICA:\n\nACHADOS:\n\nCONCLUSÃO:'],
      ['XA', 'Angiografia', 'ANGIOGRAFIA — {{DESCRICAO_EXAME}}\n\nINDICAÇÃO CLÍNICA:\n{{INDICACAO}}\n\nTÉCNICA:\n\nACHADOS:\n\nCONCLUSÃO:'],
    ];
    for (const template of templates) insert.run(...template);
  }

  return db;
}
