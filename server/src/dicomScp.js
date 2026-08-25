// DICOM SCP (Service Class Provider) — listens for C-STORE associations
// from modalities and stores received .dcm files to disk.
//
// Uses dcmjs for parsing DICOM data sets. The TCP association handling
// here is a simplified implementation of the DICOM upper-layer protocol
// (PDU exchange). For a production-grade SCP you may want to use a
// library like `node-dicom` (dimse) that implements the full upper-layer
// state machine. This module gives you the skeleton + storage logic.
//
// FUTURE EXTENSION POINTS:
//   - C-FIND SCP:   implement query handling so other PACS can query us
//   - C-MOVE SCU:   fetch studies from another PACS server
//   - Cloud backup: after storing, push to S3 / GCS / Azure Blob

import { createServer, Socket } from 'node:net';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import dcmjs from 'dcmjs';
import { enforceLicense } from './license.js';
import { writeDicomFile } from './dataProtection.js';
import { buildPixelPayload, pixelCachePathForDicom, writePixelCache } from './dicomPixelCache.js';

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;

// DICOM PDU types (simplified upper-layer protocol)
const PDU_ASSOCIATE_REQUEST = 0x01;
const PDU_ASSOCIATE_ACCEPT = 0x02;
const PDU_ASSOCIATE_REJECT = 0x03;
const PDU_DATA = 0x04;
const PDU_RELEASE_REQUEST = 0x05;
const PDU_RELEASE_RESPONSE = 0x06;

export class DicomScp {
  constructor(config, db, logger) {
    this.config = config;
    this.db = db;
    this.logger = logger;
    this.server = null;
    this.running = false;
    this.activeConnections = 0;
    this.maxConnections = 25;
  }

  start() {
    if (this.running) return Promise.resolve();
    const { listenIp, listenPort } = this.config;

    return new Promise((resolvePromise, rejectPromise) => {
      this.server = createServer((socket) => this.handleConnection(socket));

      const onError = (err) => {
        this.running = false;
        this.logger.error(`SCP server error on ${listenIp}:${listenPort}: ${err.message}`, 'SCP');
        rejectPromise(err);
      };

      this.server.once('error', onError);
      this.server.listen(listenPort, listenIp, () => {
        this.server.off('error', onError);
        this.server.on('error', (err) => {
          this.running = false;
          this.logger.error(`SCP server error: ${err.message}`, 'SCP');
        });
        this.running = true;
        this.logger.success(`SCP listening on ${listenIp}:${listenPort} (AE: ${this.config.aeTitle})`, 'SCP');
        resolvePromise();
      });
    });
  }

  stop() {
    if (this.server) {
      const server = this.server;
      this.server = null;
      this.running = false;
      this.logger.warning('SCP server stopped', 'SCP');
      return new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
      });
    }
    this.running = false;
    return Promise.resolve();
  }

  handleConnection(socket) {
    const remoteAddr = `${socket.remoteAddress}`;
    if (this.activeConnections >= this.maxConnections) { this.logger.warning(`Connection limit reached: ${remoteAddr}`, 'SECURITY'); socket.destroy(); return; }
    this.activeConnections += 1;
    socket.setTimeout(30000, () => { this.logger.warning(`DICOM socket timeout: ${remoteAddr}`, 'SECURITY'); socket.destroy(); });
    let associationBuffer = Buffer.alloc(0);
    let currentAssociation = null;

    this.logger.info(`New TCP connection from ${remoteAddr}`, 'SCP');

    socket.on('data', (data) => {
      associationBuffer = Buffer.concat([associationBuffer, data]);
      if (associationBuffer.length > 512 * 1024 * 1024) { this.logger.error(`DICOM association exceeded 512 MB: ${remoteAddr}`, 'SECURITY'); socket.destroy(); return; }
      associationBuffer = this.processPdus(socket, associationBuffer, currentAssociation);
    });

    socket.on('error', (err) => {
      this.logger.error(`Socket error from ${remoteAddr}: ${err.message}`, 'SCP');
    });

    socket.on('close', () => {
      this.activeConnections = Math.max(0, this.activeConnections - 1);
      this.logger.info(`Connection closed from ${remoteAddr}`, 'SCP');
    });
  }

  // Parse and handle PDUs from the buffer.
  // This is a simplified PDU parser — the real DICOM upper layer
  // has a full state machine (Artim, Sta1..Sta13). For robustness
  // in production, consider a dedicated DIMSE library.
  processPdus(socket, buffer, _association) {
    while (buffer.length >= 6) {
      const pduType = buffer[0];
      const pduLength = buffer.readUInt32BE(2);
      if (pduLength > 512 * 1024 * 1024) { this.logger.error(`Rejected oversized DICOM PDU: ${pduLength} bytes`, 'SECURITY'); socket.destroy(); return; }
      const totalLen = 6 + pduLength;

      if (buffer.length < totalLen) break; // incomplete PDU, wait for more

      const pdu = buffer.subarray(0, totalLen);
      buffer = buffer.subarray(totalLen);

      switch (pduType) {
        case PDU_ASSOCIATE_REQUEST:
          this.handleAssociateRequest(socket, pdu);
          break;
        case PDU_DATA:
          this.handleStoreData(socket, pdu);
          break;
        case PDU_RELEASE_REQUEST:
          this.sendPdu(socket, Buffer.from([PDU_RELEASE_RESPONSE, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00]));
          break;
        default:
          break;
      }
    }
    return buffer;
  }

  handleAssociateRequest(socket, pdu) {
    // Extract called AE Title (bytes 10..25) and calling AE Title (bytes 26..41)
    const calledAe = pdu.subarray(10, 26).toString('ascii').trim();
    const callingAe = pdu.subarray(26, 42).toString('ascii').trim();
    const normalizedCallingAe = callingAe.toUpperCase();
    const remoteAddr = socket.remoteAddress;

    const normalizedRemote = String(remoteAddr).replace(/^::ffff:/, '');
    const device = this.config.remoteDevices.find((d) => d.enabled && d.kind !== 'printer' && d.forPacs !== false && String(d.aeTitle ?? '').trim().toUpperCase() === normalizedCallingAe && (d.ip === normalizedRemote || d.ip === '127.0.0.1' && normalizedRemote === '::1'));
    if (!device) {
      if (!this.config.dicom?.acceptUnknownSources) {
        this.logger.warning(`Association rejected: unknown AE Title "${callingAe}" from ${remoteAddr}`, 'SCP');
        this.sendAssociateReject(socket);
        socket.end();
        return;
      }
      this.logger.warning(`Association source not registered, accepting anyway: "${callingAe}" from ${remoteAddr}`, 'SCP');
    }

    if (calledAe !== this.config.aeTitle) {
      this.logger.warning(`Association called AE "${calledAe}" differs from configured AE "${this.config.aeTitle}", accepting anyway`, 'SCP');
    }

    this.logger.success(`Association accepted: ${callingAe} from ${remoteAddr}`, 'SCP');
    socket.dicomAssociation = { callingAe, calledAe, command: Buffer.alloc(0), dataset: Buffer.alloc(0), pcId: 1, messageId: 1 };

    // Build A-ASSOCIATE-AC PDU (simplified — accepts the presentation contexts)
    const acceptPdu = this.buildAssociateAccept(pdu);
    socket.write(acceptPdu);
  }

  sendAssociateReject(socket) {
    // A-ASSOCIATE-RJ: result=1 (rejected-permanent), source=1 (DUL), reason=1
    const reject = Buffer.from([
      PDU_ASSOCIATE_REJECT, 0x00, 0x00, 0x00, 0x00, 0x04,
      0x00, 0x01, 0x01, 0x01,
    ]);
    socket.write(reject);
  }

  buildAssociateAccept(requestPdu) {
    // Minimal A-ASSOCIATE-AC: echo back presentation contexts as accepted.
    // A production implementation must negotiate abstract syntaxes
    // (e.g. 1.2.840.10008.5.1.4.1.1.2 for CT Image Storage) properly.
    const protocolVersion = Buffer.alloc(2);
    protocolVersion.writeUInt16BE(0x0001, 0);
    const protocolReserved = Buffer.alloc(2);

    const calledAe = requestPdu.subarray(10, 26);
    const callingAe = requestPdu.subarray(26, 42);

    let applicationContext = null;
    const pcItems = [];
    let offset = 74; // PDU header + fixed A-ASSOCIATE fields
    while (offset + 4 <= requestPdu.length) {
      const itemType = requestPdu[offset];
      const itemLen = requestPdu.readUInt16BE(offset + 2);
      const nextOffset = offset + 4 + itemLen;
      if (nextOffset > requestPdu.length) break;

      if (itemType === 0x10) {
        applicationContext = requestPdu.subarray(offset, nextOffset);
      }

      if (itemType === 0x20) {
        const pcId = requestPdu[offset + 4];
        const pcBody = Buffer.alloc(4);
        pcBody[0] = pcId;
        pcBody[1] = 0x00;
        pcBody[2] = 0x00; // result = acceptance
        pcBody[3] = 0x00;

        const tsUid = Buffer.from('1.2.840.10008.1.2', 'ascii');
        const tsItem = Buffer.alloc(4 + tsUid.length);
        tsItem[0] = 0x40;
        tsItem[1] = 0x00;
        tsItem.writeUInt16BE(tsUid.length, 2);
        tsUid.copy(tsItem, 4);

        const pcItemBody = Buffer.concat([pcBody, tsItem]);
        const pcItem = Buffer.alloc(4 + pcItemBody.length);
        pcItem[0] = 0x21;
        pcItem[1] = 0x00;
        pcItem.writeUInt16BE(pcItemBody.length, 2);
        pcItemBody.copy(pcItem, 4);
        pcItems.push(pcItem);
      }

      offset = nextOffset;
    }

    if (!applicationContext) {
      const appUid = Buffer.from('1.2.840.10008.3.1.1.1', 'ascii');
      applicationContext = Buffer.alloc(4 + appUid.length);
      applicationContext[0] = 0x10;
      applicationContext[1] = 0x00;
      applicationContext.writeUInt16BE(appUid.length, 2);
      appUid.copy(applicationContext, 4);
    }

    const maxLengthBody = Buffer.alloc(4);
    maxLengthBody.writeUInt32BE(16 * 1024 * 1024, 0);
    const maxLengthItem = Buffer.alloc(4 + maxLengthBody.length);
    maxLengthItem[0] = 0x51;
    maxLengthItem[1] = 0x00;
    maxLengthItem.writeUInt16BE(maxLengthBody.length, 2);
    maxLengthBody.copy(maxLengthItem, 4);

    const implementationUid = Buffer.from('1.2.826.0.1.3680043.10.543.1', 'ascii');
    const implementationItem = Buffer.alloc(4 + implementationUid.length);
    implementationItem[0] = 0x52;
    implementationItem[1] = 0x00;
    implementationItem.writeUInt16BE(implementationUid.length, 2);
    implementationUid.copy(implementationItem, 4);

    const userInfoBody = Buffer.concat([maxLengthItem, implementationItem]);
    const userInfo = Buffer.alloc(4 + userInfoBody.length);
    userInfo[0] = 0x50;
    userInfo[1] = 0x00;
    userInfo.writeUInt16BE(userInfoBody.length, 2);
    userInfoBody.copy(userInfo, 4);

    // Build the full A-ASSOCIATE-AC PDU
    const body = Buffer.concat([
      protocolVersion,
      protocolReserved,
      calledAe,
      callingAe,
      Buffer.alloc(32), // reserved
      applicationContext,
      ...pcItems,
      userInfo,
    ]);

    const header = Buffer.alloc(6);
    header[0] = PDU_ASSOCIATE_ACCEPT;
    header.writeUInt32BE(body.length, 2);

    return Buffer.concat([header, body]);
  }

  handleData(socket, pdu) {
    // P-DATA-TF contains PDV (Protocol Data Value) items.
    // Each PDV: [pcId(1)] [msgHeader(1)] [pdv data...]
    // msgHeader bit 0 = end-of-message, bit 1 = command/data
    // This simplified handler extracts DIMSE C-STORE command + data sets.
    //
    // FUTURE: implement C-FIND-RP and C-MOVE-RQ handling here.
    let offset = 6; // skip PDU header
    while (offset < pdu.length - 6) {
      const pdvLen = pdu.readUInt32BE(offset);
      const pdvEnd = offset + 4 + pdvLen;
      if (pdvEnd > pdu.length) break;

      const msgHeader = pdu[offset + 5];
      const pdvData = pdu.subarray(offset + 6, pdvEnd);
      const isCommand = (msgHeader & 0x02) !== 0;
      const isEndOfMessage = (msgHeader & 0x01) !== 0;

      if (!isCommand && isEndOfMessage) {
        // This is a data set (C-STORE dataset) — parse and store it
        this.storeDataset(pdvData);
      }

      offset = pdvEnd;
    }
  }

  handleStoreData(socket, pdu) {
    let offset = 6;
    while (offset < pdu.length - 6) {
      const pdvLen = pdu.readUInt32BE(offset);
      const pdvEnd = offset + 4 + pdvLen;
      if (pdvEnd > pdu.length) break;

      const pcId = pdu[offset + 4];
      const msgHeader = pdu[offset + 5];
      const pdvData = pdu.subarray(offset + 6, pdvEnd);
      const isCommand = (msgHeader & 0x02) !== 0;
      const isEndOfMessage = (msgHeader & 0x01) !== 0;
      const association = socket.dicomAssociation ?? { command: Buffer.alloc(0), dataset: Buffer.alloc(0), pcId, messageId: 1 };
      association.pcId = pcId;

      if (isCommand) {
        association.command = Buffer.concat([association.command, pdvData]);
        if (isEndOfMessage) {
          association.messageId = readCommandUs(association.command, 0x0120) ?? 1;
          association.sopClassUid = readCommandString(association.command, 0x0002) ?? '';
          association.sopInstanceUid = readCommandString(association.command, 0x1000) ?? '';
        }
      } else {
        association.dataset = Buffer.concat([association.dataset, pdvData]);
        if (isEndOfMessage) {
          const stored = this.storeDataset(association.dataset);
          this.sendCStoreResponse(socket, association, stored ? 0x0000 : 0xa700);
          association.command = Buffer.alloc(0);
          association.dataset = Buffer.alloc(0);
        }
      }

      socket.dicomAssociation = association;
      offset = pdvEnd;
    }
  }

  storeDataset(pdvData) {
    try {
      enforceLicense({ feature: 'dicom-store', db: this.db, config: this.config, additionalBytes: pdvData.length });
      // Parse the DICOM dataset using dcmjs
      // dcmjs expects a Buffer of raw DICOM data
      const dicomDict = DicomMessage.read(pdvData);
      const meta = DicomMetaDictionary.naturalizeDataset(dicomDict);

      const patientId = meta.PatientID ?? 'UNKNOWN';
      const patientName = meta.PatientName ?? 'UNKNOWN^UNKNOWN';
      const studyUid = meta.StudyInstanceUID ?? `unknown-${Date.now()}`;
      const seriesUid = meta.SeriesInstanceUID ?? `unknown-${Date.now()}`;
      const sopUid = meta.SOPInstanceUID ?? `unknown-${Date.now()}`;

      // Build storage path: storagePath/patientId/studyUid/seriesUid/sopUid.dcm
      const dir = join(this.config.storagePath, patientId, studyUid, seriesUid);
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, `${sopUid}.dcm`);
      writeDicomFile(filePath, pdvData);

      const pixelCachePath = this.cachePixels(meta, filePath);

      // Index metadata in SQLite
      this.indexInstance(meta, studyUid, seriesUid, sopUid, filePath, pixelCachePath);

      this.logger.success(
        `C-STORE stored: ${patientName} | ${meta.Modality ?? '?'} | ${sopUid}.dcm`,
        'SCP',
      );
      return true;
    } catch (err) {
      this.logger.error(`Failed to store DICOM dataset: ${err.message}`, 'SCP');
      return false;
    }
  }

  sendCStoreResponse(socket, association, status) {
    const command = buildCStoreResponseCommand({
      messageId: association.messageId ?? 1,
      sopClassUid: association.sopClassUid ?? '',
      sopInstanceUid: association.sopInstanceUid ?? '',
      status,
    });
    const pdvLength = command.length + 2;
    const body = Buffer.alloc(4 + pdvLength);
    body.writeUInt32BE(pdvLength, 0);
    body[4] = association.pcId ?? 1;
    body[5] = 0x03;
    command.copy(body, 6);

    const header = Buffer.alloc(6);
    header[0] = PDU_DATA;
    header.writeUInt32BE(body.length, 2);
    this.sendPdu(socket, Buffer.concat([header, body]));
  }

  importFile(sourcePath) {
    const fileBuffer = readFileSync(sourcePath);
    enforceLicense({ feature: 'local-import', db: this.db, config: this.config, additionalBytes: fileBuffer.length });
    const arrayBuffer = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
    const dicomFile = DicomMessage.readFile(arrayBuffer);
    const meta = DicomMetaDictionary.naturalizeDataset(dicomFile.dict);
    const patientId = String(meta.PatientID ?? 'UNKNOWN');
    const studyUid = String(meta.StudyInstanceUID ?? `unknown-study-${Date.now()}`);
    const seriesUid = String(meta.SeriesInstanceUID ?? `unknown-series-${Date.now()}`);
    const sopUid = String(meta.SOPInstanceUID ?? `unknown-instance-${Date.now()}`);
    const dir = join(this.config.storagePath, patientId, studyUid, seriesUid);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${sopUid}.dcm`);
    writeDicomFile(filePath, fileBuffer);
    const pixelCachePath = this.cachePixels(meta, filePath);
    const indexed = this.indexInstance(meta, studyUid, seriesUid, sopUid, filePath, pixelCachePath);
    this.logger.success(`Imported DICOM: ${sourcePath}`, 'IMPORT');
    return { patientId, studyUid, seriesUid, sopUid, filePath, ...indexed };
  }

  cachePixels(meta, filePath) {
    try {
      const cachePath = pixelCachePathForDicom(filePath);
      writePixelCache(cachePath, buildPixelPayload(meta));
      return cachePath;
    } catch (error) {
      this.logger.warning(`Pixel cache nao gerado: ${error.message}`, 'PIXEL_CACHE');
      return '';
    }
  }

  indexInstance(meta, studyUid, seriesUid, sopUid, filePath, pixelCachePath = '') {
    const db = this.db;

    // Upsert patient
    let patientRow = db.prepare('SELECT id FROM patients WHERE patient_id = ?').get(meta.PatientID ?? 'UNKNOWN');
    if (!patientRow) {
      const info = db.prepare(
        'INSERT INTO patients (patient_id, patient_name, birth_date, sex) VALUES (?, ?, ?, ?)',
      ).run(
        meta.PatientID ?? 'UNKNOWN',
        String(meta.PatientName ?? 'UNKNOWN'),
        meta.PatientBirthDate ?? '',
        meta.PatientSex ?? '',
      );
      patientRow = { id: info.lastInsertRowid };
    }

    // Upsert study
    let studyRow = db.prepare('SELECT id FROM studies WHERE study_instance_uid = ?').get(studyUid);
    if (!studyRow) {
      const info = db.prepare(
        `INSERT INTO studies (study_instance_uid, patient_id, accession_number, study_date, study_time, modality, study_description, source_ae_title, storage_path, institution_name, referring_physician)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        studyUid,
        patientRow.id,
        meta.AccessionNumber ?? '',
        meta.StudyDate ?? '',
        meta.StudyTime ?? '',
        meta.Modality ?? '',
        meta.StudyDescription ?? '',
        meta.StationAETitle ?? '',
        join(this.config.storagePath, meta.PatientID ?? 'UNKNOWN', studyUid),
        meta.InstitutionName ?? '',
        String(meta.ReferringPhysicianName ?? ''),
      );
      studyRow = { id: info.lastInsertRowid };
    }
    db.prepare('UPDATE studies SET institution_name = ?, referring_physician = ?, source_ae_title = ? WHERE id = ?').run(
      meta.InstitutionName ?? '', String(meta.ReferringPhysicianName ?? ''), meta.StationAETitle ?? '', studyRow.id,
    );

    // Upsert series
    let seriesRow = db.prepare('SELECT id FROM series WHERE series_instance_uid = ?').get(seriesUid);
    if (!seriesRow) {
      const info = db.prepare(
        `INSERT INTO series (series_instance_uid, study_id, series_number, modality, series_description, body_part_examined)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        seriesUid,
        studyRow.id,
        meta.SeriesNumber ?? 0,
        meta.Modality ?? '',
        meta.SeriesDescription ?? '',
        meta.BodyPartExamined ?? '',
      );
      seriesRow = { id: info.lastInsertRowid };
    }

    // Insert instance
    db.prepare(
      `INSERT OR IGNORE INTO instances (sop_instance_uid, series_id, instance_number, file_path, pixel_cache_path, width, height)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sopUid,
      seriesRow.id,
      meta.InstanceNumber ?? 0,
      filePath,
      pixelCachePath,
      meta.Rows ?? 0,
      meta.Columns ?? 0,
    );
    if (pixelCachePath) db.prepare('UPDATE instances SET pixel_cache_path = ? WHERE sop_instance_uid = ?').run(pixelCachePath, sopUid);

    // Update counts
    db.prepare('UPDATE series SET image_count = (SELECT COUNT(*) FROM instances WHERE series_id = ?) WHERE id = ?')
      .run(seriesRow.id, seriesRow.id);
    db.prepare('UPDATE studies SET series_count = (SELECT COUNT(*) FROM series WHERE study_id = ?), image_count = (SELECT COUNT(*) FROM instances i JOIN series s ON i.series_id = s.id WHERE s.study_id = ?) WHERE id = ?')
      .run(studyRow.id, studyRow.id, studyRow.id);
    return { studyId: Number(studyRow.id), seriesId: Number(seriesRow.id) };
  }

  // C-ECHO test — connects to a remote device and verifies reachability.
  // FUTURE EXTENSION: full C-FIND / C-MOVE SCU implementation goes here.
  async testEcho(device) {
    return new Promise((resolvePromise) => {
      const socket = new Socket();
      socket.setTimeout(10000);

      socket.on('connect', () => {
        socket.destroy();
        resolvePromise({ success: true, message: 'TCP reachable' });
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolvePromise({ success: false, message: 'Connection timed out' });
      });
      socket.on('error', (err) => {
        resolvePromise({ success: false, message: err.message });
      });
      socket.connect(device.port, device.ip);
    });
  }

  sendPdu(socket, pdu) {
    socket.write(pdu);
  }
}

function readCommandUs(command, element) {
  let offset = 0;
  while (offset + 8 <= command.length) {
    const group = command.readUInt16LE(offset);
    const currentElement = command.readUInt16LE(offset + 2);
    const length = command.readUInt32LE(offset + 4);
    const valueOffset = offset + 8;
    if (group === 0x0000 && currentElement === element && length >= 2 && valueOffset + 2 <= command.length) {
      return command.readUInt16LE(valueOffset);
    }
    offset = valueOffset + length;
  }
  return null;
}

function readCommandString(command, element) {
  let offset = 0;
  while (offset + 8 <= command.length) {
    const group = command.readUInt16LE(offset);
    const currentElement = command.readUInt16LE(offset + 2);
    const length = command.readUInt32LE(offset + 4);
    const valueOffset = offset + 8;
    if (group === 0x0000 && currentElement === element && valueOffset + length <= command.length) {
      return command.subarray(valueOffset, valueOffset + length).toString('ascii').replace(/\0+$/, '').trim();
    }
    offset = valueOffset + length;
  }
  return null;
}

function buildCStoreResponseCommand({ messageId, sopClassUid, sopInstanceUid, status }) {
  const elements = [
    commandUi(0x0000, 0x0002, sopClassUid),
    commandUs(0x0000, 0x0100, 0x8001),
    commandUs(0x0000, 0x0120, messageId),
    commandUs(0x0000, 0x0800, 0x0101),
    commandUs(0x0000, 0x0900, status),
    commandUi(0x0000, 0x1000, sopInstanceUid),
  ];
  const rest = Buffer.concat(elements);
  return Buffer.concat([commandUl(0x0000, 0x0000, rest.length), rest]);
}

function commandUi(group, element, value) {
  const text = String(value || '1.2.840.10008.5.1.4.1.1.7');
  const raw = Buffer.from(text, 'ascii');
  const padded = raw.length % 2 === 0 ? raw : Buffer.concat([raw, Buffer.from([0])]);
  const buffer = Buffer.alloc(8 + padded.length);
  buffer.writeUInt16LE(group, 0);
  buffer.writeUInt16LE(element, 2);
  buffer.writeUInt32LE(padded.length, 4);
  padded.copy(buffer, 8);
  return buffer;
}

function commandUs(group, element, value) {
  const buffer = Buffer.alloc(10);
  buffer.writeUInt16LE(group, 0);
  buffer.writeUInt16LE(element, 2);
  buffer.writeUInt32LE(2, 4);
  buffer.writeUInt16LE(value, 8);
  return buffer;
}

function commandUl(group, element, value) {
  const buffer = Buffer.alloc(12);
  buffer.writeUInt16LE(group, 0);
  buffer.writeUInt16LE(element, 2);
  buffer.writeUInt32LE(4, 4);
  buffer.writeUInt32LE(value, 8);
  return buffer;
}
