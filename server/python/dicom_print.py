import argparse
import json
import math
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

FONT_5X7 = {
    " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
    ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
    "/": ["00001", "00010", "00100", "01000", "10000", "00000", "00000"],
    ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
    "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "11100"],
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
    "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "G": ["01111", "10000", "10000", "10011", "10001", "10001", "01111"],
    "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    "I": ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
    "J": ["00001", "00001", "00001", "00001", "10001", "10001", "01110"],
    "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    "Q": ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
    "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    "W": ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
    "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
    "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
    "Z": ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
}


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
    if code is None:
        return "sem status"
    details = [f"0x{code:04X}"]
    comment = getattr(status, "ErrorComment", None)
    if comment:
        details.append(str(comment))
    offending = getattr(status, "OffendingElement", None)
    if offending:
        details.append(f"OffendingElement={offending}")
    return " - ".join(details)


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


def text_value(value):
    return str(first_value(value, "") or "").replace("^", " ").strip()


def dicom_date(value):
    value = text_value(value)
    if len(value) == 8 and value.isdigit():
        return f"{value[6:8]}/{value[4:6]}/{value[0:4]}"
    return value


def dicom_time(value):
    value = text_value(value).split(".")[0]
    if len(value) >= 6 and value[:6].isdigit():
        return f"{value[0:2]}:{value[2:4]}:{value[4:6]}"
    if len(value) >= 4 and value[:4].isdigit():
        return f"{value[0:2]}:{value[2:4]}"
    return value


def clean_footer_text(value):
    replacements = str.maketrans({
        "Á": "A", "À": "A", "Â": "A", "Ã": "A", "Ä": "A",
        "É": "E", "È": "E", "Ê": "E", "Ë": "E",
        "Í": "I", "Ì": "I", "Î": "I", "Ï": "I",
        "Ó": "O", "Ò": "O", "Ô": "O", "Õ": "O", "Ö": "O",
        "Ú": "U", "Ù": "U", "Û": "U", "Ü": "U",
        "Ç": "C",
    })
    clean = text_value(value).upper().translate(replacements)
    return "".join(ch if ch in FONT_5X7 else " " for ch in clean)


def footer_lines(ds):
    patient = text_value(getattr(ds, "PatientName", ""))
    patient_id = text_value(getattr(ds, "PatientID", ""))
    birth = dicom_date(getattr(ds, "PatientBirthDate", ""))
    sex = text_value(getattr(ds, "PatientSex", ""))
    study = text_value(getattr(ds, "StudyDescription", "")) or text_value(getattr(ds, "SeriesDescription", ""))
    modality = text_value(getattr(ds, "Modality", ""))
    study_date = dicom_date(getattr(ds, "StudyDate", ""))
    study_time = dicom_time(getattr(ds, "StudyTime", ""))
    institution = text_value(getattr(ds, "InstitutionName", ""))
    line1 = f"PACIENTE: {patient or '-'}   ID: {patient_id or '-'}   SEXO: {sex or '-'}   NASC: {birth or '-'}"
    line2 = f"ESTUDO: {study or '-'}   MOD: {modality or '-'}   DATA: {study_date or '-'} {study_time or ''}".strip()
    if institution:
        line2 = f"{line2}   INST: {institution}"
    return [clean_footer_text(line1), clean_footer_text(line2)]


def draw_text(pixels, rows, cols, x, y, text, scale=2, color=235):
    cursor = x
    char_width = 6 * scale
    max_chars = max(0, (cols - x - 4) // char_width)
    for ch in clean_footer_text(text)[:max_chars]:
        glyph = FONT_5X7.get(ch, FONT_5X7[" "])
        for gy, row in enumerate(glyph):
            for gx, bit in enumerate(row):
                if bit != "1":
                    continue
                for sy in range(scale):
                    py = y + gy * scale + sy
                    if py < 0 or py >= rows:
                        continue
                    offset = py * cols
                    for sx in range(scale):
                        px = cursor + gx * scale + sx
                        if 0 <= px < cols:
                            pixels[offset + px] = color
        cursor += char_width


def draw_marker(pixels, rows, cols, x, y, label, scale=3):
    text = clean_footer_text(label).strip()
    if not text:
        return
    char_width = 6 * scale
    text_width = len(text) * char_width
    text_height = 7 * scale
    start_x = int(round(x - text_width / 2))
    start_y = int(round(y - text_height / 2))
    draw_text(pixels, rows, cols, start_x, start_y, text, scale=scale, color=255)


def parse_layout_dims(layout):
    text = str(layout or "1x1").lower().replace(" ", "")
    if "x" in text:
        left, _, right = text.partition("x")
        try:
            return max(1, int(left)), max(1, int(right))
        except ValueError:
            pass
    return 1, 1


def cell_aspect_ratio(layout, orientation):
    # A folha de impressao (ver PrintCenter.tsx) usa uma proporcao fixa de
    # 10:13 no retrato / 13:10 na paisagem, dividida igualmente entre as
    # celulas do layout. Reproduz a mesma conta aqui pra a caixa da imagem
    # no filme ter a mesma proporcao vista no preview.
    rows, cols = parse_layout_dims(layout)
    sheet_aspect = (13 / 10) if str(orientation or "").upper().startswith("LAND") else (10 / 13)
    return max(sheet_aspect * (rows / cols), 1e-3)


def render_framed(rows, cols, pixels, viewport, cell_aspect, annotation_points):
    # Reproduz, em Python, a mesma transformacao (zoom/pan/rotacao/espelhamento)
    # que o canvas do preview de impressao aplica via applyTransform/screenToImage
    # em dicomViewer.ts, pra a imagem impressa no filme mostrar exatamente o
    # enquadramento e a marcacao vistos na tela em vez do DICOM cru centralizado.
    img_w, img_h = cols, rows
    zoom = float(viewport.get("zoom") or 1) or 1
    pan_x = float(viewport.get("panX") or 0)
    pan_y = float(viewport.get("panY") or 0)
    flip_h = bool(viewport.get("flipH"))
    flip_v = bool(viewport.get("flipV"))
    try:
        rotation_deg = int(viewport.get("rotation") or 0) % 360
    except (TypeError, ValueError):
        rotation_deg = 0
    rotation_rad = math.radians(rotation_deg)
    cos_r = math.cos(rotation_rad)
    sin_r = math.sin(rotation_rad)

    target_area = max(1, img_w * img_h)
    out_h = max(64, min(1400, int(round(math.sqrt(target_area / cell_aspect)))))
    out_w = max(64, min(1400, int(round(out_h * cell_aspect))))

    base_scale = min(out_w / img_w, out_h / img_h)
    scale = max(base_scale * zoom, 1e-6)

    out = bytearray(out_w * out_h)
    for oy in range(out_h):
        y = (oy - out_h / 2 - pan_y) / scale
        row_offset = oy * out_w
        for ox in range(out_w):
            x = (ox - out_w / 2 - pan_x) / scale
            rx = x * cos_r + y * sin_r
            ry = -x * sin_r + y * cos_r
            fx = -rx if flip_h else rx
            fy = -ry if flip_v else ry
            sx = int(round(fx + img_w / 2))
            sy = int(round(fy + img_h / 2))
            if 0 <= sx < img_w and 0 <= sy < img_h:
                out[row_offset + ox] = pixels[sy * img_w + sx]

    projected = []
    for ax, ay in annotation_points:
        px = ax - img_w / 2
        py = ay - img_h / 2
        if flip_h:
            px = -px
        if flip_v:
            py = -py
        rx = px * cos_r - py * sin_r
        ry = px * sin_r + py * cos_r
        projected.append((rx * scale + out_w / 2 + pan_x, ry * scale + out_h / 2 + pan_y))

    return out_h, out_w, out, projected


def add_footer(ds, rows, cols, pixels, footer_lines_override=None):
    # A tela de impressao mostra o rodape com os dados do estudo gravados no
    # banco do PACS (nome do paciente, modalidade, data, instituicao), que
    # podem nao estar preenchidos nas tags do proprio arquivo DICOM (comum em
    # estudos de teste/anonimizados). Quando o preview manda esse texto pronto,
    # ele e usado ao inves de reler as tags do arquivo, pra o filme bater
    # exatamente com o que aparece na tela.
    lines = [clean_footer_text(str(line)) for line in footer_lines_override if str(line).strip()] if footer_lines_override else footer_lines(ds)
    if not lines:
        lines = footer_lines(ds)

    scale = 3 if cols < 1400 else 4
    text_height = 7 * scale
    padding = max(12, scale * 5)
    footer_height = max(76, text_height * len(lines) + padding * (len(lines) + 1))
    footer_height = min(max(footer_height, rows // 9), rows // 4)
    output_rows = rows + footer_height
    output = bytearray(output_rows * cols)
    output[:len(pixels)] = pixels
    start = rows * cols
    output[start:] = bytes([0]) * (footer_height * cols)
    line_y = rows + padding
    for line in lines:
        draw_text(output, output_rows, cols, padding, line_y, line, scale=scale)
        line_y += text_height + padding
    return output_rows, cols, output


def percentile(values, percent):
    if not values:
        return 0
    ordered = sorted(values)
    index = int(round((len(ordered) - 1) * percent / 100))
    return ordered[max(0, min(index, len(ordered) - 1))]


def describe_object(ds):
    modality = str(getattr(ds, "Modality", "") or "?")
    sop_class_uid = getattr(ds, "SOPClassUID", None)
    if sop_class_uid:
        try:
            sop_class = sop_class_uid.name
        except Exception:
            sop_class = str(sop_class_uid)
    else:
        sop_class = "?"
    return f"Modality={modality}, SOPClass={sop_class}"


def raw_pixel_values(ds):
    if "PixelData" not in ds:
        raise RuntimeError(f"DICOM sem PixelData ({describe_object(ds)}).")
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
        raise RuntimeError(f"DICOM sem Rows/Columns ({describe_object(ds)}).")
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


def normalize_pixels(path, overrides=None, layout="1x1", orientation="PORTRAIT"):
    ds = dcmread(path, force=True)
    rows, cols, values = raw_pixel_values(ds)
    slope = float(getattr(ds, "RescaleSlope", 1) or 1)
    intercept = float(getattr(ds, "RescaleIntercept", 0) or 0)
    values = [(value * slope) + intercept for value in values]

    # O preview de impressao manda o brilho/contraste (window center/width)
    # ajustado na tela; sem isso a impressora usa o valor gravado no DICOM
    # (ou um calculo automatico), que raramente bate com o que foi visto.
    center = None
    width = None
    if overrides and overrides.get("windowCenter") is not None and overrides.get("windowWidth"):
        try:
            center = float(overrides["windowCenter"])
            width = float(overrides["windowWidth"])
        except (TypeError, ValueError):
            center = None
            width = None

    if center is None or not width or width <= 1:
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

    # Zoom/pan/rotacao/espelhamento e as marcacoes D/E/texto vem do preview de
    # impressao (ver PrintCenter.tsx); sem isso a impressora recebia a imagem
    # inteira, centralizada, sem o enquadramento que o usuario ajustou na tela.
    viewport = overrides or {}
    cell_aspect = cell_aspect_ratio(layout, orientation)
    annotation_items = [a for a in (viewport.get("annotations") or []) if str((a or {}).get("label", "")).strip()]
    annotation_points = []
    for annotation in annotation_items:
        try:
            annotation_points.append((float(annotation.get("x", 0)), float(annotation.get("y", 0))))
        except (TypeError, ValueError, AttributeError):
            annotation_points.append((0.0, 0.0))

    rows, cols, pixels, projected_points = render_framed(rows, cols, pixels, viewport, cell_aspect, annotation_points)

    for (px, py), annotation in zip(projected_points, annotation_items):
        draw_marker(pixels, rows, cols, px, py, str(annotation.get("label", "")))

    footer_override = viewport.get("footerLines") if isinstance(viewport.get("footerLines"), list) else None
    rows, cols, pixels = add_footer(ds, rows, cols, pixels, footer_lines_override=footer_override)

    image = Dataset()
    image.SamplesPerPixel = 1
    image.PhotometricInterpretation = "MONOCHROME2"
    image.Rows = rows
    image.Columns = cols
    image.BitsAllocated = 8
    image.BitsStored = 8
    image.HighBit = 7
    image.PixelRepresentation = 0
    image.PixelAspectRatio = [1, 1]
    image.PixelData = bytes(pixels)
    return image


def require_success(step, status, extra=None):
    if status is None:
        detail = f"{step} falhou sem resposta DICOM da impressora"
        if extra:
            detail += f" ({extra})"
        raise RuntimeError(detail)
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
    parser.add_argument("--manifest", required=True, help="JSON com [{file, windowCenter, windowWidth, rotation, flipH, flipV, annotations}]")
    args = parser.parse_args()

    with open(args.manifest, "r", encoding="utf-8") as manifest_file:
        manifest_items = json.load(manifest_file)
    if not isinstance(manifest_items, list) or not manifest_items:
        emit({"ok": False, "printed": 0, "error": "Manifesto de impressao vazio ou invalido."})
        return 2

    ae = AE(ae_title=args.calling_ae[:16])
    ae.acse_timeout = 20
    ae.dimse_timeout = 180
    ae.network_timeout = 180
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
        film_box_uid = str(
            getattr(status, "AffectedSOPInstanceUID", None)
            or getattr(response, "SOPInstanceUID", None)
            or film_box_uid
        )

        boxes = list(getattr(response, "ReferencedImageBoxSequence", []) or [])
        if not boxes:
            raise RuntimeError("A impressora nao retornou Image Boxes para o Film Box.")

        # Objetos sem pixel (relatorio estruturado, folha de dose, PDF, etc.) sao
        # ignorados: o filme sai com as imagens que podem ser renderizadas em vez
        # de a impressao inteira falhar por causa de uma instancia nao-imagem.
        pending = list(manifest_items)
        skipped = []
        filled = 0
        for box in boxes[:image_box_count]:
            placed = False
            while pending and not placed:
                current = pending.pop(0)
                current_file = current.get("file") if isinstance(current, dict) else current
                try:
                    image = normalize_pixels(
                        current_file,
                        overrides=current if isinstance(current, dict) else None,
                        layout=args.layout,
                        orientation=args.orientation,
                    )
                except Exception as error:
                    skipped.append({"file": current_file, "error": str(error)})
                    continue
                attrs = Dataset()
                attrs.ImageBoxPosition = filled + 1
                attrs.Polarity = "NORMAL"
                attrs.MagnificationType = "REPLICATE"
                attrs.SmoothingType = "NONE"
                attrs.BasicGrayscaleImageSequence = Sequence([image])
                status, _ = assoc.send_n_set(
                    attrs,
                    box.ReferencedSOPClassUID,
                    box.ReferencedSOPInstanceUID,
                    meta_uid=BasicGrayscalePrintManagementMeta,
                )
                require_success("N-SET Basic Grayscale Image Box", status, f"posicao {filled + 1}")
                filled += 1
                placed = True

        if filled == 0:
            raise RuntimeError(f"Nenhuma imagem do estudo pode ser impressa: {skipped[:5] or 'sem instancias com pixel'}")

        status, _ = assoc.send_n_action(
            None,
            0x0001,
            BasicFilmBox,
            film_box_uid,
            meta_uid=BasicGrayscalePrintManagementMeta,
        )
        assoc_state = f"assoc e={int(assoc.is_established)} r={int(assoc.is_released)} a={int(assoc.is_aborted)}"
        if status is None and assoc.is_released and not assoc.is_aborted:
            printed = 1
            message = "Comando de impressao enviado; a impressora encerrou a associacao sem status final."
            if skipped:
                message += f" {len(skipped)} objeto(s) sem imagem ignorado(s)."
            emit({"ok": True, "printed": printed, "sent": filled, "skipped": len(skipped), "message": message})
            return 0
        require_success("N-ACTION Print Film Box", status, assoc_state)
        printed = 1
        message = "Filme enviado para impressora DICOM."
        if skipped:
            message += f" {len(skipped)} objeto(s) sem imagem ignorado(s)."
        emit({"ok": True, "printed": printed, "sent": filled, "skipped": len(skipped), "message": message})
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
