import argparse
import json
import sys

from pydicom import dcmread
from pydicom.uid import ExplicitVRLittleEndian, ImplicitVRLittleEndian
from pynetdicom import AE, StoragePresentationContexts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--calling-ae", required=True)
    parser.add_argument("--called-ae", required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("files", nargs="+")
    args = parser.parse_args()

    ae = AE(ae_title=args.calling_ae[:16])
    transfer_syntaxes = [ImplicitVRLittleEndian, ExplicitVRLittleEndian]
    for context in StoragePresentationContexts:
        ae.add_requested_context(context.abstract_syntax, transfer_syntaxes)

    assoc = ae.associate(args.host, args.port, ae_title=args.called_ae[:16])
    if not assoc.is_established:
        print(json.dumps({
            "ok": False,
            "sent": 0,
            "failed": len(args.files),
            "error": f"Associacao DICOM recusada. Confira AE IMPRESSORA={args.called_ae[:16]}, AE LOCAL={args.calling_ae[:16]}, IP={args.host} e porta={args.port}."
        }))
        return 2

    sent = 0
    failures = []
    try:
        for file_path in args.files:
            try:
                dataset = dcmread(file_path, force=True)
                status = assoc.send_c_store(dataset)
                code = getattr(status, "Status", None)
                if code == 0x0000:
                    sent += 1
                else:
                    failures.append({"file": file_path, "status": f"0x{int(code or 0):04X}"})
            except Exception as error:
                failures.append({"file": file_path, "error": str(error)})
    finally:
        assoc.release()

    ok = sent > 0 and not failures
    print(json.dumps({"ok": ok, "sent": sent, "failed": len(failures), "failures": failures[:20]}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
