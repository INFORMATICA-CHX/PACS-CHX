import argparse
import json
import os
import sys
import uuid
from pathlib import Path

from pydicom.dataset import Dataset
from pydicom.uid import ExplicitVRLittleEndian, ImplicitVRLittleEndian
from pynetdicom import AE, AllStoragePresentationContexts, evt
from pynetdicom.sop_class import ModalityWorklistInformationFind, Verification


def log(level, message):
    print(json.dumps({"level": level, "message": message}), flush=True)


def normalize_ip(address):
    return str(address or "").replace("::ffff:", "")


def load_config(path):
    with open(path, "r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def load_worklist(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            payload = json.load(handle)
        return payload.get("items", [])
    except FileNotFoundError:
        return []
    except Exception as error:
        log("error", f"Could not load worklist cache: {error}")
        return []


def dicom_date(value):
    return "".join(ch for ch in str(value or "") if ch.isdigit())[:8]


def dicom_time(value):
    return "".join(ch for ch in str(value or "") if ch.isdigit())[:6]


def get_query_sps_date(query):
    try:
        return str(query.ScheduledProcedureStepSequence[0].ScheduledProcedureStepStartDate or "").strip()
    except Exception:
        return ""


def date_matches(requested_date, row_date):
    requested_date = str(requested_date or "").strip()
    row_date = dicom_date(row_date)
    if not requested_date:
        return True

    if "-" not in requested_date:
        return dicom_date(requested_date) == row_date

    start, end = requested_date.split("-", 1)
    start = dicom_date(start)
    end = dicom_date(end)
    if start and row_date < start:
        return False
    if end and row_date > end:
        return False
    return True


def query_summary(query):
    return {
        "modality": str(getattr(query, "Modality", "") or "").strip(),
        "patient_id": str(getattr(query, "PatientID", "") or "").strip(),
        "accession_number": str(getattr(query, "AccessionNumber", "") or "").strip(),
        "scheduled_date": get_query_sps_date(query),
    }


def matches_query(row, query, device):
    target_aes = [str(value).strip().upper() for value in row.get("target_ae_titles", [])]
    if target_aes and str(device.get("aeTitle", "")).strip().upper() not in target_aes:
        return False

    modality = str(getattr(query, "Modality", "") or "").strip().upper()
    if modality and str(row.get("modality", "")).strip().upper() != modality:
        return False

    patient_id = str(getattr(query, "PatientID", "") or "").strip()
    if patient_id and patient_id != str(row.get("patient_id", "")).strip():
        return False

    accession = str(getattr(query, "AccessionNumber", "") or "").strip()
    if accession and accession != str(row.get("accession_number", "")).strip():
        return False

    requested_date = get_query_sps_date(query)
    if not date_matches(requested_date, row.get("scheduled_date")):
        return False

    return True


def worklist_dataset(row, ae_title):
    ds = Dataset()
    ds.PatientID = str(row.get("patient_id", "") or "")
    ds.PatientName = str(row.get("patient_name", "") or "")
    if row.get("birth_date"):
        ds.PatientBirthDate = dicom_date(row.get("birth_date"))
    if row.get("sex"):
        ds.PatientSex = str(row.get("sex", "") or "")
    ds.AccessionNumber = str(row.get("accession_number", "") or "")
    ds.ReferringPhysicianName = str(row.get("referring_physician", "") or "")

    sps = Dataset()
    sps.ScheduledStationAETitle = str(ae_title or "")
    sps.ScheduledProcedureStepStartDate = dicom_date(row.get("scheduled_date"))
    sps.ScheduledProcedureStepStartTime = dicom_time(row.get("scheduled_time"))
    sps.Modality = str(row.get("modality", "") or "")
    sps.ScheduledProcedureStepDescription = str(row.get("requested_procedure", "") or "")
    sps.ScheduledProcedureStepID = str(row.get("accession_number", "") or row.get("id", "") or "")
    ds.ScheduledProcedureStepSequence = [sps]

    ds.RequestedProcedureID = str(row.get("accession_number", "") or row.get("id", "") or "")
    ds.RequestedProcedureDescription = str(row.get("requested_procedure", "") or "")
    uid_seed = str(row.get("accession_number", row.get("id", "0")))
    ds.StudyInstanceUID = f"2.25.{uuid.uuid5(uuid.NAMESPACE_DNS, uid_seed).int}"
    return ds


def allowed_device(config, assoc):
    calling_ae = assoc.requestor.ae_title.strip().upper()
    remote_ip = normalize_ip(assoc.requestor.address)
    ip_match = None
    for device in config.get("remoteDevices", []):
        if not device.get("enabled"):
            continue
        device_ip = str(device.get("ip", "")).strip()
        if device_ip == remote_ip or (device_ip == "127.0.0.1" and remote_ip == "::1"):
            ip_match = device
            if str(device.get("aeTitle", "")).strip().upper() != calling_ae:
                continue
            return device
    return ip_match


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--inbox", required=True)
    args = parser.parse_args()

    config = load_config(args.config)
    inbox = Path(args.inbox)
    inbox.mkdir(parents=True, exist_ok=True)
    db_path = str(config.get("dbPath", "") or "").strip()
    worklist_cache = Path(db_path).with_name("worklist-cache.json") if db_path else Path(args.config).with_name("worklist-cache.json")

    ae_title = str(config.get("aeTitle", "PACSCHX")).strip() or "PACSCHX"
    listen_ip = str(config.get("listenIp", "127.0.0.1")).strip() or "127.0.0.1"
    listen_port = int(config.get("listenPort", 11112))
    active_devices = [
        f"{str(device.get('aeTitle', '')).strip()}@{str(device.get('ip', '')).strip()}"
        for device in config.get("remoteDevices", [])
        if device.get("enabled")
    ]

    ae = AE(ae_title=ae_title)
    if hasattr(ae, "require_called_aet"):
        ae.require_called_aet = False
    transfer_syntaxes = [ImplicitVRLittleEndian, ExplicitVRLittleEndian]
    for context in AllStoragePresentationContexts:
        ae.add_supported_context(context.abstract_syntax, transfer_syntaxes)
    ae.add_supported_context(ModalityWorklistInformationFind, transfer_syntaxes)
    ae.add_supported_context(Verification, transfer_syntaxes)

    def handle_store(event):
        device = allowed_device(config, event.assoc)
        if not device:
            allowed = ", ".join(active_devices) or "none"
            if not config.get("dicom", {}).get("acceptUnknownSources", False):
                log("warning", f"Association not authorized: {event.assoc.requestor.ae_title.strip()} from {event.assoc.requestor.address}; allowed: {allowed}")
                return 0x0124
            log("warning", f"C-STORE source not registered, accepting anyway: {event.assoc.requestor.ae_title.strip()} from {event.assoc.requestor.address}; allowed: {allowed}")

        dataset = event.dataset
        dataset.file_meta = event.file_meta
        sop_uid = str(getattr(dataset, "SOPInstanceUID", "") or event.request.AffectedSOPInstanceUID or "unknown")
        safe_name = "".join(ch if ch.isalnum() or ch in ".-" else "_" for ch in sop_uid)
        temporary = inbox / f"{safe_name}.{os.getpid()}.part"
        final = inbox / f"{safe_name}.dcm"
        dataset.save_as(str(temporary), write_like_original=False)
        temporary.replace(final)
        log("success", f"C-STORE received: {sop_uid} from {event.assoc.requestor.ae_title.strip()} ({event.assoc.requestor.address})")
        return 0x0000

    def handle_find(event):
        device = allowed_device(config, event.assoc)
        if not device:
            allowed = ", ".join(active_devices) or "none"
            log("warning", f"Worklist query not authorized: {event.assoc.requestor.ae_title.strip()} from {event.assoc.requestor.address}; allowed: {allowed}")
            yield 0xA700, None
            return

        rows = load_worklist(worklist_cache)
        matches = [row for row in rows if matches_query(row, event.identifier, device)]
        log(
            "info",
            "Worklist C-FIND from "
            f"{event.assoc.requestor.ae_title.strip()} ({event.assoc.requestor.address}) "
            f"matched device {str(device.get('aeTitle', '')).strip()} "
            f"with filters {json.dumps(query_summary(event.identifier), ensure_ascii=False)} "
            f"returned {len(matches)} item(s)",
        )
        for row in matches:
            yield 0xFF00, worklist_dataset(row, device.get("aeTitle"))

    def handle_echo(event):
        device = allowed_device(config, event.assoc)
        if not device:
            allowed = ", ".join(active_devices) or "none"
            if not config.get("dicom", {}).get("acceptUnknownSources", False):
                log("warning", f"C-ECHO not authorized: {event.assoc.requestor.ae_title.strip()} from {event.assoc.requestor.address}; allowed: {allowed}")
                return 0x0124
            log("warning", f"C-ECHO source not registered, accepting anyway: {event.assoc.requestor.ae_title.strip()} from {event.assoc.requestor.address}; allowed: {allowed}")
        else:
            log("success", f"C-ECHO accepted from {event.assoc.requestor.ae_title.strip()} ({event.assoc.requestor.address})")
            return 0x0000
        log("success", f"C-ECHO accepted from {event.assoc.requestor.ae_title.strip()} ({event.assoc.requestor.address})")
        return 0x0000

    handlers = [(evt.EVT_C_STORE, handle_store), (evt.EVT_C_FIND, handle_find), (evt.EVT_C_ECHO, handle_echo)]
    log("success", f"Python DICOM SCP listening on {listen_ip}:{listen_port} (AE: {ae_title})")
    log("info", f"Authorized DICOM nodes: {', '.join(active_devices) if active_devices else 'none'}")
    ae.start_server((listen_ip, listen_port), block=True, evt_handlers=handlers)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        log("error", str(error))
        sys.exit(1)
