function text(value, max = 256) {
  return String(value ?? '').trim().slice(0, max);
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function nextAccession(base, index, total) {
  if (total <= 1 || index === 0) return base;
  const suffix = `-${index + 1}`;
  return `${base.slice(0, Math.max(1, 16 - suffix.length))}${suffix}`;
}

function validateIncident(modality, incident) {
  const rules = parseJson(modality.required_rules || '{}', {});
  const missing = [];
  if (rules.body_part && !incident.body_part) missing.push('regiao anatomica');
  if (rules.view_position && !incident.view_position) missing.push('incidencia/view position');
  if (rules.laterality && !incident.laterality) missing.push('lateralidade');
  if (rules.protocol && !incident.protocol_code) missing.push('codigo de protocolo');
  if (missing.length) throw new Error(`${modality.dicom_code}: informe ${missing.join(', ')} em ${incident.description}.`);
}

export function resolveAndInsertWorklist(db, item, requestedTargets) {
  const risCode = text(item.risCode || item.requestedProcedureCode, 64);
  if (!risCode) {
    const result = insertEntry(db, item, requestedTargets, null, 0, 1);
    return { unmapped: false, ids: [Number(result.lastInsertRowid)], entries: 1 };
  }

  const mapping = db.prepare(`SELECT m.*, md.dicom_code, md.name AS modality_name, md.required_rules
    FROM worklist_mapped_exams m JOIN worklist_modalities md ON md.id=m.modality_id
    WHERE m.ris_code=? AND m.active=1 AND md.active=1`).get(risCode);
  if (!mapping) {
    const queued = db.prepare(`INSERT INTO worklist_unmapped_queue
      (ris_code, received_description, request_payload) VALUES (?, ?, ?)`)
      .run(risCode, text(item.requestedProcedure, 256), JSON.stringify({ ...item, targetDevices: requestedTargets }));
    return { unmapped: true, queueId: Number(queued.lastInsertRowid), ids: [], entries: 0 };
  }

  let incidents = db.prepare('SELECT * FROM worklist_exam_incidents WHERE ris_code=? ORDER BY sort_order,id').all(risCode);
  const selected = Array.isArray(item.selectedIncidenceIds) ? item.selectedIncidenceIds.map(Number).filter(Number.isFinite) : [];
  if (selected.length) incidents = incidents.filter((incident) => selected.includes(Number(incident.id)));
  if (!incidents.length) throw new Error(`O exame ${risCode} nao possui incidencias selecionadas.`);
  incidents.forEach((incident) => validateIncident(mapping, incident));

  const transaction = db.transaction(() => incidents.map((incident, index) => Number(insertEntry(
    db,
    { ...item, modality: mapping.dicom_code },
    requestedTargets,
    incident,
    index,
    incidents.length,
  ).lastInsertRowid)));
  return { unmapped: false, ids: transaction(), entries: incidents.length, mapping: risCode };
}

function insertEntry(db, item, requestedTargets, incident, index, total) {
  return db.prepare(`INSERT INTO modality_worklist (
    patient_id, patient_name, birth_date, sex, accession_number, modality,
    requested_procedure, scheduled_date, scheduled_time, referring_physician,
    target_devices, sent_devices, status, ris_code, incidence_id,
    requested_procedure_code, coding_scheme, code_meaning, body_part, view_position, laterality, contrast_flag
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      item.patientId, item.patientName, item.birthDate, item.sex,
      nextAccession(item.accessionNumber, index, total), text(item.modality, 16),
      incident?.description || item.requestedProcedure, item.scheduledDate, item.scheduledTime,
      item.referringPhysician, JSON.stringify(requestedTargets), '[]',
      text(item.risCode || item.requestedProcedureCode, 64), incident?.id ?? null,
      incident?.protocol_code || text(item.requestedProcedureCode, 64),
      incident?.coding_scheme || '99PACSCHX', incident?.code_meaning || incident?.description || item.requestedProcedure,
      incident?.body_part || '', incident?.view_position || '', incident?.laterality || '', item.contrastFlag ? 1 : 0,
    );
}

function catalog(db) {
  return {
    modalities: db.prepare('SELECT * FROM worklist_modalities ORDER BY dicom_code').all().map((row) => ({ ...row, required_rules: parseJson(row.required_rules, {}) })),
    mappings: db.prepare(`SELECT m.*, md.dicom_code AS modality FROM worklist_mapped_exams m
      JOIN worklist_modalities md ON md.id=m.modality_id ORDER BY m.ris_code`).all(),
    incidents: db.prepare('SELECT * FROM worklist_exam_incidents ORDER BY ris_code,sort_order,id').all(),
    unmapped: db.prepare("SELECT id,ris_code,received_description,status,created_at,mapped_at,released_at FROM worklist_unmapped_queue ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id DESC LIMIT 500").all(),
  };
}

export function registerWorklistMappingRoutes(router, { db, clinical, roles, requireFeature, appendAudit, writeCache, config }) {
  const access = [clinical, requireFeature('worklist')];
  const admin = [clinical, roles('admin', 'maintenance'), requireFeature('worklist')];
  router.get('/api/worklist/catalog', ...access, (_req, res) => res.json(catalog(db)));

  router.post('/api/worklist/modalities', ...admin, (req, res) => {
    try {
      const code = text(req.body?.dicomCode, 16).toUpperCase();
      const name = text(req.body?.name, 128);
      if (!/^[A-Z0-9]{1,16}$/.test(code) || !name) throw new Error('Informe codigo DICOM e nome da modalidade.');
      const result = db.prepare('INSERT INTO worklist_modalities (dicom_code,name,required_rules) VALUES (?,?,?)').run(code, name, JSON.stringify(req.body?.requiredRules ?? {}));
      res.status(201).json({ id: Number(result.lastInsertRowid) });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.put('/api/worklist/modalities/:id', ...admin, (req, res) => {
    try {
      db.prepare("UPDATE worklist_modalities SET name=?,active=?,required_rules=?,updated_at=datetime('now') WHERE id=?")
        .run(text(req.body?.name, 128), req.body?.active === false ? 0 : 1, JSON.stringify(req.body?.requiredRules ?? {}), req.params.id);
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.post('/api/worklist/mappings', ...admin, (req, res) => {
    try {
      const risCode = text(req.body?.risCode, 64);
      if (!risCode || !Number(req.body?.modalityId)) throw new Error('Informe codigo RIS e modalidade.');
      const incidents = Array.isArray(req.body?.incidents) ? req.body.incidents : [];
      const create = db.transaction(() => {
        db.prepare('INSERT INTO worklist_mapped_exams (ris_code,received_description,modality_id) VALUES (?,?,?)')
          .run(risCode, text(req.body?.description, 256), Number(req.body.modalityId));
        incidents.forEach((incident, index) => insertIncident(db, risCode, incident, index + 1));
        releasePending(db, risCode);
      });
      create(); writeCache();
      appendAudit(db, { actor: req.clinicalUser.user, role: req.clinicalUser.role, action: 'WORKLIST_MAPPING_CREATED', resource: `RIS:${risCode}`, details: { incidents: incidents.length }, ip: req.ip });
      res.status(201).json({ ok: true, risCode });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.put('/api/worklist/mappings/:risCode', ...admin, (req, res) => {
    try {
      db.prepare("UPDATE worklist_mapped_exams SET received_description=?,modality_id=?,active=?,updated_at=datetime('now') WHERE ris_code=?")
        .run(text(req.body?.description, 256), Number(req.body?.modalityId), req.body?.active === false ? 0 : 1, req.params.risCode);
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.delete('/api/worklist/mappings/:risCode', ...admin, (req, res) => {
    db.transaction(() => {
      db.prepare('DELETE FROM worklist_exam_incidents WHERE ris_code=?').run(req.params.risCode);
      db.prepare('DELETE FROM worklist_mapped_exams WHERE ris_code=?').run(req.params.risCode);
    })();
    res.json({ ok: true });
  });
  router.post('/api/worklist/mappings/:risCode/duplicate', ...admin, (req, res) => {
    try {
      const source = db.prepare('SELECT * FROM worklist_mapped_exams WHERE ris_code=?').get(req.params.risCode);
      const nextCode = text(req.body?.risCode, 64);
      if (!source || !nextCode) throw new Error('Mapeamento de origem ou novo codigo invalido.');
      const duplicate = db.transaction(() => {
        db.prepare('INSERT INTO worklist_mapped_exams (ris_code,received_description,modality_id,active) VALUES (?,?,?,?)').run(nextCode, source.received_description, source.modality_id, source.active);
        for (const row of db.prepare('SELECT * FROM worklist_exam_incidents WHERE ris_code=? ORDER BY sort_order,id').all(source.ris_code)) insertIncident(db, nextCode, row, row.sort_order);
      });
      duplicate(); res.status(201).json({ ok: true });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.post('/api/worklist/mappings/:risCode/incidents', ...admin, (req, res) => {
    try { const result = insertIncident(db, req.params.risCode, req.body ?? {}, req.body?.sortOrder); res.status(201).json({ id: Number(result.lastInsertRowid) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.put('/api/worklist/incidents/:id', ...admin, (req, res) => {
    try {
      const value = normalizeIncident(req.body ?? {});
      db.prepare(`UPDATE worklist_exam_incidents SET sort_order=?,description=?,protocol_code=?,coding_scheme=?,code_meaning=?,body_part=?,view_position=?,laterality=?,observation=?,updated_at=datetime('now') WHERE id=?`)
        .run(value.sortOrder, value.description, value.protocolCode, value.codingScheme, value.codeMeaning, value.bodyPart, value.viewPosition, value.laterality, value.observation, req.params.id);
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.delete('/api/worklist/incidents/:id', ...admin, (req, res) => { db.prepare('DELETE FROM worklist_exam_incidents WHERE id=?').run(req.params.id); res.json({ ok: true }); });

  router.get('/api/worklist/catalog/export', ...admin, (req, res) => {
    const data = catalog(db);
    if (req.query.format !== 'csv') return res.json(data);
    const header = 'codigo_ris,descricao,modalidade,ordem,incidencia,codigo_protocolo,esquema,significado,body_part,view_position,lateralidade';
    const rows = data.incidents.map((incident) => {
      const mapping = data.mappings.find((entry) => entry.ris_code === incident.ris_code) || {};
      return [incident.ris_code, mapping.received_description, mapping.modality, incident.sort_order, incident.description, incident.protocol_code, incident.coding_scheme, incident.code_meaning, incident.body_part, incident.view_position, incident.laterality].map(csv).join(',');
    });
    res.type('text/csv').send([header, ...rows].join('\n'));
  });
}

function normalizeIncident(value) {
  const description = text(value.description, 256);
  if (!description) throw new Error('Informe a descricao da incidencia.');
  return {
    sortOrder: Math.max(1, Number(value.sortOrder ?? value.sort_order) || 1), description,
    protocolCode: text(value.protocolCode ?? value.protocol_code, 64), codingScheme: text(value.codingScheme ?? value.coding_scheme, 16) || '99PACSCHX',
    codeMeaning: text(value.codeMeaning ?? value.code_meaning, 128) || description, bodyPart: text(value.bodyPart ?? value.body_part, 16).toUpperCase(),
    viewPosition: text(value.viewPosition ?? value.view_position, 16).toUpperCase(), laterality: text(value.laterality, 2).toUpperCase(), observation: text(value.observation, 512),
  };
}

function insertIncident(db, risCode, raw, fallbackOrder) {
  const value = normalizeIncident({ ...raw, sortOrder: raw.sortOrder ?? raw.sort_order ?? fallbackOrder });
  return db.prepare(`INSERT INTO worklist_exam_incidents (ris_code,sort_order,description,protocol_code,coding_scheme,code_meaning,body_part,view_position,laterality,observation) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(risCode, value.sortOrder, value.description, value.protocolCode, value.codingScheme, value.codeMeaning, value.bodyPart, value.viewPosition, value.laterality, value.observation);
}

function releasePending(db, risCode) {
  for (const pending of db.prepare("SELECT * FROM worklist_unmapped_queue WHERE ris_code=? AND status='pending' ORDER BY id").all(risCode)) {
    try {
      const payload = parseJson(pending.request_payload, {});
      const result = resolveAndInsertWorklist(db, payload, payload.targetDevices ?? []);
      db.prepare("UPDATE worklist_unmapped_queue SET status='released',mapped_at=datetime('now'),released_at=datetime('now') WHERE id=?").run(pending.id);
      if (!result.ids.length) throw new Error('Nenhuma incidencia liberada.');
    } catch {
      db.prepare("UPDATE worklist_unmapped_queue SET status='mapped',mapped_at=datetime('now') WHERE id=?").run(pending.id);
    }
  }
}

function csv(value) { return `"${String(value ?? '').replaceAll('"', '""')}"`; }
