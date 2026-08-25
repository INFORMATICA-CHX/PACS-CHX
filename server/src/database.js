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

    CREATE INDEX IF NOT EXISTS idx_studies_patient ON studies(patient_id);
    CREATE INDEX IF NOT EXISTS idx_series_study ON series(study_id);
    CREATE INDEX IF NOT EXISTS idx_instances_series ON instances(series_id);
    CREATE INDEX IF NOT EXISTS idx_reports_study ON reports(study_id);
    CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_modality_worklist_date ON modality_worklist(scheduled_date, scheduled_time);
    CREATE INDEX IF NOT EXISTS idx_modality_worklist_status ON modality_worklist(status);

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
  ]) {
    try { db.exec(sql); } catch { /* column already exists */ }
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
