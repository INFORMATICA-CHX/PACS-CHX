import argparse
import json
import struct
import sys

from pydicom import dcmread
from pydicom.dataset import Dataset
from pydicom.sequence import Sequence
from pydicom.uid import ExplicitVRLittleEndian, ImplicitVRLittleEndian, generate_uid
from pynetdicom import AE
from pynetdicom.sop_class import (
    BasicFilmBox,
    BasicFilmSession,
    BasicGrayscaleImageBox,
    BasicGrayscalePrintManagementMeta,
    Printer,
)


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def status_code(status):
    code = getattr(status, "Status", None)
    return int(code) if code is not None else None


def status_ok(status):
    code = status_code(status)
    return code in (0x0000, 0x0001, 0xB600, 0xB601, 0xB602, 0xB603, 0xB604, 0xB605, 0xB609)


def status_text(status):
    code = status_code(status)
    return "sem status" if code is None else f"0x{code:04X}"


def layout_format(layout):
    clean = str(layout or "1x1").lower().replace(" ", "")
    if clean in {"1x1", "1,1"}:
        return "STANDARD\\1,1", 1
    if clean in {"1x2", "1,2"}:
        return "STANDARD\\1,2", 2
    if clean in {"2x1", "2,1"}:
        return "STANDARD\\2,1", 2
    if clean in {"2x2", "2,2"}:
        return "STANDARD\\2,2", 4
    if clean in {"3x3", "3,3"}:
        return "STANDARD\\3,3", 9
    return "STANDARD\\1,1", 1


def first_value(value, fallback=None):
    if isinstance(value, (list, tuple)):
        return value[0] if value else fallback
    try:
        if hasattr(value, "__iter__") and not isinstance(value, (str, bytes)):
            return list(value)[0]
    except Exception:
        pass
    return value if value is not None else fallback


def percentile(values, percent):
    if not values:
        return 0
    ordered = sorted(values)
    index = int(round((len(ordered) - 1) * percent / 100))
    return ordered[max(0, min(index, len(ordered) - 1))]


def raw_pixel_values(ds):
    if "PixelData" not in ds:
        raise RuntimeError("DICOM sem PixelData.")
    transfer_syntax = str(getattr(getattr(ds, "file_meta", None), "TransferSyntaxUID", "") or "")
    if transfer_syntax and transfer_syntax not in {
        "1.2.840.10008.1.2",
        "1.2.840.10008.1.2.1",
        "1.2.840.10008.1.2.1.99",
    }:
        raise RuntimeError(f"Transfer Syntax comprimida/nao suportada para impressao direta: {transfer_syntax}")

    rows = int(getattr(ds, "Rows", 0) or 0)
    cols = int(getattr(ds, "Columns", 0) or 0)
    samples = max(1, int(getattr(ds, "SamplesPerPixel", 1) or 1))
    bits_allocated = int(getattr(ds, "BitsAllocated", 16) or 16)
    pixel_representation = int(getattr(ds, "PixelRepresentation", 0) or 0)
    frame_count = max(1, int(first_value(getattr(ds, "NumberOfFrames", 1), 1) or 1))
    if not rows or not cols:
        raise RuntimeError("DICOM sem Rows/Columns.")
    if bits_allocated not in (8, 16):
        raise RuntimeError(f"BitsAllocated {bits_allocated} nao suportado para impressao.")

    count = rows * cols * samples
    frame_stride = count * (bits_allocated // 8)
    raw = bytes(ds.PixelData[:frame_stride])
    if len(raw) < frame_stride:
        raise RuntimeError("PixelData truncado.")

    values = []
    if bits_allocated == 8:
        source = list(raw[:count])
    else:
        fmt = "<" + ("h" if pixel_representation else "H") * count
        source = list(struct.unpack(fmt, raw[:frame_stride]))

    for index in range(rows * cols):
        if samples == 1:
            values.append(float(source[index]))
        else:
            offset = index * samples
            values.append(sum(float(item) for item in source[offset:offset + samples]) / samples)
    return rows, cols, values


def normalize_pixels(path):
    ds = dcmread(path, force=True)
    rows, cols, values = raw_pixel_values(ds)
    slope = float(getattr(ds, "RescaleSlope", 1) or 1)
    intercept = float(getattr(ds, "RescaleIntercept", 0) or 0)
    values = [(value * slope) + intercept for value in values]

    center = first_value(getattr(ds, "WindowCenter", None))
    width = first_value(getattr(ds, "WindowWidth", None))
    try:
        center = float(center)
        width = float(width)
    except Exception:
        center = None
        width = None

    if center is not None and width and width > 1:
        low = center - width / 2
        high = center + width / 2
    else:
        sample_step = max(1, len(values) // 20000)
        sample = values[::sample_step]
        low = float(percentile(sample, 1))
        high = float(percentile(sample, 99))
        if high <= low:
            low = float(min(values))
            high = float(max(values) or 1)

    scale = max(high - low, 1)
    invert = str(getattr(ds, "PhotometricInterpretation", "")).upper() == "MONOCHROME1"
    pixels = bytearray(len(values))
    for index, value in enumerate(values):
        normalized = max(0.0, min(1.0, (value - low) / scale))
        if invert:
            normalized = 1.0 - normalized
        pixels[index] = int(round(normalized * 255))
    if str(getattr(ds, "PhotometricInterpretation", "")).upper() == "MONOCHROME1":
        pass

    image = Dataset()
    image.SamplesPerPixel = 1
    image.PhotometricInterpretation = "MONOCHROME2"
    image.Rows = rows
    image.Columns = cols
    image.BitsAllocated = 8
    image.BitsStored = 8
    image.HighBit = 7
    image.PixelRepresentation = 0
    image.PixelData = bytes(pixels)
    return image


def require_success(step, status, extra=None):
    if not status_ok(status):
        detail = f"{step} falhou com status DICOM {status_text(status)}"
        if extra:
            detail += f" ({extra})"
        raise RuntimeError(detail)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--calling-ae", required=True)
    parser.add_argument("--called-ae", required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--copies", default=1, type=int)
    parser.add_argument("--layout", default="1x1")
    parser.add_argument("--orientation", default="PORTRAIT")
    parser.add_argument("--film-size", default="14INX17IN")
    parser.add_argument("files", nargs="+")
    args = parser.parse_args()

    ae = AE(ae_title=args.calling_ae[:16])
    ae.acse_timeout = 20
    ae.dimse_timeout = 45
    ae.network_timeout = 45
    transfer_syntaxes = [ImplicitVRLittleEndian, ExplicitVRLittleEndian]
    ae.add_requested_context(BasicGrayscalePrintManagementMeta, transfer_syntaxes)
    ae.add_requested_context(BasicFilmSession, transfer_syntaxes)
    ae.add_requested_context(BasicFilmBox, transfer_syntaxes)
    ae.add_requested_context(BasicGrayscaleImageBox, transfer_syntaxes)
    ae.add_requested_context(Printer, transfer_syntaxes)

    assoc = ae.associate(args.host, args.port, ae_title=args.called_ae[:16])
    if not assoc.is_established:
        emit({
            "ok": False,
            "printed": 0,
            "error": (
                "Associacao DICOM Print recusada. Confira AE IMPRESSORA, AE LOCAL autorizado, IP/porta "
                "e se a impressora habilitou Basic Grayscale Print Management."
            ),
        })
        return 2

    film_session_uid = generate_uid()
    film_box_uid = generate_uid()
    printed = 0

    try:
        session = Dataset()
        session.NumberOfCopies = str(max(1, int(args.copies or 1)))
        session.PrintPriority = "MED"
        session.MediumType = "BLUE FILM"
        session.FilmDestination = "MAGAZINE"

        status, _ = assoc.send_n_create(
            session,
            BasicFilmSession,
            film_session_uid,
            meta_uid=BasicGrayscalePrintManagementMeta,
        )
        require_success("N-CREATE Basic Film Session", status)

        image_display_format, image_box_count = layout_format(args.layout)
        film_box = Dataset()
        film_box.ImageDisplayFormat = image_display_format
        film_box.FilmOrientation = str(args.orientation or "PORTRAIT").upper()
        film_box.FilmSizeID = str(args.film_size or "14INX17IN").upper()
        film_box.MagnificationType = "REPLICATE"
        film_box.BorderDensity = "BLACK"
        film_box.EmptyImageDensity = "BLACK"
        film_box.Trim = "NO"
        film_box.ReferencedFilmSessionSequence = Sequence([Dataset()])
        film_box.ReferencedFilmSessionSequence[0].ReferencedSOPClassUID = BasicFilmSession
        film_box.ReferencedFilmSessionSequence[0].ReferencedSOPInstanceUID = film_session_uid

        status, response = assoc.send_n_create(
            film_box,
            BasicFilmBox,
            film_box_uid,
            meta_uid=BasicGrayscalePrintManagementMeta,
        )
        require_success("N-CREATE Basic Film Box", status)

        boxes = list(getattr(response, "ReferencedImageBoxSequence", []) or [])
        if not boxes:
            raise RuntimeError("A impressora nao retornou Image Boxes para o Film Box.")

        failures = []
        for index, box in enumerate(boxes[: min(image_box_count, len(args.files))]):
            try:
                image = normalize_pixels(args.files[index])
                attrs = Dataset()
                attrs.ImagePosition = index + 1
                attrs.BasicGrayscaleImageSequence = Sequence([image])
                status, _ = assoc.send_n_set(
                    attrs,
                    box.ReferencedSOPClassUID,
                    box.ReferencedSOPInstanceUID,
                    meta_uid=BasicGrayscalePrintManagementMeta,
                )
                require_success("N-SET Basic Grayscale Image Box", status, f"posicao {index + 1}")
            except Exception as error:
                failures.append({"file": args.files[index], "error": str(error)})

        if failures:
            raise RuntimeError(f"Falha ao preencher imagem(ns): {failures[:5]}")

        status, _ = assoc.send_n_action(
            Dataset(),
            0x0001,
            BasicFilmBox,
            film_box_uid,
            meta_uid=BasicGrayscalePrintManagementMeta,
        )
        require_success("N-ACTION Print Film Box", status)
        printed = 1
        emit({"ok": True, "printed": printed, "sent": min(image_box_count, len(args.files)), "message": "Filme enviado para impressora DICOM."})
        return 0
    except Exception as error:
        emit({"ok": False, "printed": printed, "error": str(error)})
        return 1
    finally:
        try:
            assoc.send_n_delete(BasicFilmSession, film_session_uid, meta_uid=BasicGrayscalePrintManagementMeta)
        except Exception:
            pass
        assoc.release()


if __name__ == "__main__":
    sys.exit(main())
