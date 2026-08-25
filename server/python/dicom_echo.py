import argparse
import json
import socket
import sys

from pydicom.uid import ExplicitVRLittleEndian, ImplicitVRLittleEndian
from pynetdicom import AE
from pynetdicom.sop_class import Verification


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--calling-ae", required=True)
    parser.add_argument("--called-ae", required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--timeout", default=8, type=int)
    args = parser.parse_args()

    try:
        with socket.create_connection((args.host, args.port), timeout=args.timeout):
            pass
    except OSError as error:
        emit({"ok": False, "tcpReachable": False, "error": f"Falha de rede: {error}"})
        return 1

    ae = AE(ae_title=args.calling_ae[:16])
    ae.acse_timeout = args.timeout
    ae.dimse_timeout = args.timeout
    ae.network_timeout = args.timeout
    ae.add_requested_context(Verification, [ImplicitVRLittleEndian, ExplicitVRLittleEndian])

    assoc = ae.associate(args.host, args.port, ae_title=args.called_ae[:16])
    if not assoc.is_established:
        emit({
            "ok": False,
            "tcpReachable": True,
            "error": (
                "Rede e porta acessiveis, mas o equipamento recusou C-ECHO DICOM. "
                "Isso pode ser normal em CR que so envia imagens. Confira se ele aceita Verification/C-ECHO "
                f"e se AE destino={args.called_ae[:16]} e AE local={args.calling_ae[:16]} estao autorizados."
            ),
        })
        return 2

    status = assoc.send_c_echo()
    assoc.release()
    code = getattr(status, "Status", None)
    if code == 0x0000:
        emit({"ok": True, "tcpReachable": True, "message": "C-ECHO aceito"})
        return 0

    emit({"ok": False, "tcpReachable": True, "error": f"C-ECHO respondeu com status DICOM 0x{int(code or 0):04X}."})
    return 3


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        emit({"ok": False, "tcpReachable": False, "error": str(error)})
        sys.exit(1)
