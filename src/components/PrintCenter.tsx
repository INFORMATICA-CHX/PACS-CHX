import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Contrast, Maximize2, Moon,
  AlertTriangle, CheckCircle2, ChevronDown, Clock3, Grid2X2, Grid3X3, Image as ImageIcon, LayoutPanelLeft,
  Loader2, Move, Plus, Printer, RotateCw, Rows3, Save, Scissors, Send, Settings, Square, Tags, Trash2, Type, X, ZoomIn,
} from 'lucide-react';
import type { DicomImage, Study } from '@/types';
import type { PacsStore } from '@/lib/usePacsStore';
import { apiFetch } from '@/lib/apiClient';
import { renderImage, screenToImage, type ViewportState, viewportFromImage } from '@/lib/dicomViewer';

type PrintMode = 'dicom' | 'paper';
type PrintTool = 'wl' | 'zoom' | 'pan' | 'crop' | 'markD' | 'markE' | 'text';
type AnnotationFont = 'standard' | 'compact' | 'wide' | 'mono';
type PrintAnnotation = { id: string; cell: number; x: number; y: number; label: string; kind: 'text' | 'marker'; rotation: number; fontSize: number; fontFamily: AnnotationFont; bold: boolean };
type PrintCrop = { x: number; y: number; width: number; height: number; applied: boolean };
type FilmCalibration = { measuredWidthMm?: number; measuredHeightMm?: number; factorX?: number; factorY?: number; validated?: boolean; calibratedAt?: string };
type PrinterFilmProfile = { filmSizeId: string; widthMm: number; heightMm: number; requestedResolutionId?: string; pixelPitchMm?: number; calibration?: FilmCalibration; active?: boolean };
type RemoteDevice = { id: string; kind?: 'node' | 'printer'; aeTitle: string; callingAeTitle?: string; ip: string; port: number; description?: string; enabled?: boolean; brand?: string; model?: string; firmware?: string; pixelPitchMm?: number; filmProfiles?: PrinterFilmProfile[] };
type LayoutOption = { id: string; label: string; rows: number; cols: number; icon: typeof Square };
type PrintJob = {
  id: number | string; status: 'queued' | 'printing' | 'printed' | 'failed' | string; printer_name?: string; copies?: number;
  error_message?: string; requested_at?: string; printed_at?: string; updated_at?: string; patient_name?: string; study_description?: string;
  modality?: string; accession_number?: string; study_date?: string;
};
type LocalPrinter = { name: string; driverName?: string; portName?: string; status?: string; isDefault?: boolean };
type ServerPixelPayload = {
  width: number; height: number; pixelDataBase64: string; samplesPerPixel?: number; bitsAllocated?: number;
  pixelRepresentation?: number; pixelSpacing?: number; sliceThickness?: number; windowCenter?: number;
  windowWidth?: number; instanceNumber?: number; sliceLocation?: number; photometricInterpretation?: string;
  pixelSpacingX?: number | null; pixelSpacingY?: number | null; imagerPixelSpacingX?: number | null; imagerPixelSpacingY?: number | null;
};
type PrintPreviewImage = DicomImage & { instanceId: string; physicalSpacingX?: number; physicalSpacingY?: number; spacingSource?: 'imager' | 'pixel' };

const nominalFilms: PrinterFilmProfile[] = [
  { filmSizeId: '8INX10IN', widthMm: 203.2, heightMm: 254 },
  { filmSizeId: '10INX12IN', widthMm: 254, heightMm: 304.8 },
  { filmSizeId: '10INX14IN', widthMm: 254, heightMm: 355.6 },
  { filmSizeId: '11INX14IN', widthMm: 279.4, heightMm: 355.6 },
  { filmSizeId: '14INX14IN', widthMm: 355.6, heightMm: 355.6 },
  { filmSizeId: '14INX17IN', widthMm: 355.6, heightMm: 431.8 },
  { filmSizeId: '24CMX24CM', widthMm: 240, heightMm: 240 },
  { filmSizeId: '24CMX30CM', widthMm: 240, heightMm: 300 },
];

function printerFilms(device?: RemoteDevice) {
  const saved = device?.filmProfiles?.filter((film) => film.active !== false) ?? [];
  return saved.length ? saved : nominalFilms;
}

const annotationFontCss: Record<AnnotationFont, string> = {
  standard: 'Arial, sans-serif', compact: 'Arial Narrow, Arial, sans-serif', wide: 'Verdana, sans-serif', mono: 'Courier New, monospace',
};

const layouts: LayoutOption[] = [
  { id: '1x1', label: '1x1', rows: 1, cols: 1, icon: Square },
  { id: '1x2', label: '1x2', rows: 1, cols: 2, icon: LayoutPanelLeft },
  { id: '2x1', label: '2x1', rows: 2, cols: 1, icon: Rows3 },
  { id: '2x2', label: '2x2', rows: 2, cols: 2, icon: Grid2X2 },
  { id: '3x3', label: '3x3', rows: 3, cols: 3, icon: Grid3X3 },
];

function isPrinterDevice(device: RemoteDevice) {
  const text = `${device.aeTitle ?? ''} ${device.description ?? ''}`.toUpperCase();
  return device.kind === 'printer' || text.includes('PRINT') || text.includes('IMPRESSORA') || Number(device.port) === 104;
}

function patientName(value: string) { return value.split('^').filter(Boolean).reverse().join(' '); }

function formatDicomDate(value?: string) {
  if (!value) return '-';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  return value;
}

function formatDicomTime(value?: string) {
  if (!value) return '-';
  return value.slice(0, 8);
}

function dicomPrintFooterLines(study?: Study, presentationSizeMode = 'TRUE SIZE') {
  if (!study) return [];
  const line1 = `PACIENTE: ${patientName(study.patientName) || '-'}   ID: ${study.patientId || '-'}   SEXO: ${study.patientSex || '-'}   NASC: ${formatDicomDate(study.patientBirthDate)}`;
  const sizeLabel = presentationSizeMode === 'TRUE SIZE' ? 'REAL' : presentationSizeMode;
  const line2 = `ESTUDO: ${study.studyDescription || '-'}   MOD: ${study.modality || '-'}   DATA: ${formatDicomDate(study.studyDate)} ${formatDicomTime(study.studyTime)}${study.institution ? `   INST: ${study.institution}` : ''}   TAMANHO: ${sizeLabel}`;
  return [line1, line2];
}

function jobStatus(job: PrintJob) {
  if (job.status === 'printed') return { label: 'Enviado', icon: CheckCircle2, className: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' };
  if (job.status === 'failed') return { label: 'Falha', icon: AlertTriangle, className: 'border-red-400/30 bg-red-400/10 text-red-200' };
  if (job.status === 'printing') return { label: 'Enviando', icon: Loader2, className: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200' };
  return { label: 'Na fila', icon: Clock3, className: 'border-amber-400/30 bg-amber-400/10 text-amber-200' };
}

function formatJobDate(value?: string) {
  if (!value) return '-';
  const date = new Date(value.endsWith('Z') ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function imageFromServerPixels(payload: ServerPixelPayload): DicomImage & Pick<PrintPreviewImage, 'physicalSpacingX' | 'physicalSpacingY' | 'spacingSource'> {
  const width = Number(payload.width) || 0;
  const height = Number(payload.height) || 0;
  if (!width || !height || !payload.pixelDataBase64) throw new Error('DICOM sem pixels suportados.');
  const samplesPerPixel = Math.max(1, Number(payload.samplesPerPixel) || 1);
  const bitsAllocated = Number(payload.bitsAllocated) || 16;
  const pixelRepresentation = Number(payload.pixelRepresentation) || 0;
  const bytes = base64ToBytes(payload.pixelDataBase64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pixelData = new Float32Array(width * height);
  for (let i = 0; i < pixelData.length; i++) {
    let value = 0;
    for (let sample = 0; sample < samplesPerPixel; sample++) {
      const sampleIndex = i * samplesPerPixel + sample;
      if (bitsAllocated <= 8) value += bytes[sampleIndex] ?? 0;
      else {
        const offset = sampleIndex * 2;
        if (offset + 1 < bytes.length) value += pixelRepresentation === 1 ? view.getInt16(offset, true) : view.getUint16(offset, true);
      }
    }
    pixelData[i] = value / samplesPerPixel;
  }
  const imagerX = Number(payload.imagerPixelSpacingX);
  const imagerY = Number(payload.imagerPixelSpacingY);
  const pixelX = Number(payload.pixelSpacingX);
  const pixelY = Number(payload.pixelSpacingY);
  const physicalSpacingX = imagerX > 0 ? imagerX : pixelX > 0 ? pixelX : undefined;
  const physicalSpacingY = imagerY > 0 ? imagerY : pixelY > 0 ? pixelY : undefined;
  return {
    width,
    height,
    pixelData,
    pixelSpacing: Number(payload.pixelSpacing) || 1,
    sliceThickness: Number(payload.sliceThickness) || 1,
    windowCenter: Number(payload.windowCenter) || 40,
    windowWidth: Number(payload.windowWidth) || 400,
    instanceNumber: Number(payload.instanceNumber) || 0,
    sliceLocation: Number(payload.sliceLocation) || 0,
    photometricInterpretation: payload.photometricInterpretation === 'MONOCHROME1' ? 'MONOCHROME1' : 'MONOCHROME2',
    physicalSpacingX,
    physicalSpacingY,
    spacingSource: imagerX > 0 && imagerY > 0 ? 'imager' : physicalSpacingX && physicalSpacingY ? 'pixel' : undefined,
  };
}

function croppedDicomImage(image: DicomImage, crop?: PrintCrop): DicomImage {
  if (!crop?.applied) return image;
  const x = Math.max(0, Math.min(image.width - 1, Math.round(crop.x)));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(crop.y)));
  const width = Math.max(1, Math.min(image.width - x, Math.round(crop.width)));
  const height = Math.max(1, Math.min(image.height - y, Math.round(crop.height)));
  const pixels = new Float32Array(width * height);
  for (let row = 0; row < height; row++) pixels.set(image.pixelData.subarray((y + row) * image.width + x, (y + row) * image.width + x + width), row * width);
  return { ...image, width, height, pixelData: pixels };
}

function imageToScreenPoint(ix: number, iy: number, vp: ViewportState, canvasW: number, canvasH: number, imgW: number, imgH: number) {
  let x = ix - imgW / 2;
  let y = iy - imgH / 2;
  if (vp.flipH) x = -x;
  if (vp.flipV) y = -y;
  const rad = (vp.rotation * Math.PI) / 180;
  const rx = x * Math.cos(rad) - y * Math.sin(rad);
  const ry = x * Math.sin(rad) + y * Math.cos(rad);
  const scale = Math.min(canvasW / imgW, canvasH / imgH) * vp.zoom;
  return { x: rx * scale + canvasW / 2 + vp.panX, y: ry * scale + canvasH / 2 + vp.panY };
}

function PreviewCanvas({
  image, viewport, annotations, crop, selectedAnnotationId, activeTool, onViewportChange, onAnnotate, onCropChange, onDropImage, onClick, onSelectAnnotation, onMoveAnnotation, onRotateAnnotation, onDeleteAnnotation,
}: {
  image?: DicomImage;
  viewport: ViewportState;
  annotations: PrintAnnotation[];
  crop?: PrintCrop;
  selectedAnnotationId?: string;
  activeTool: PrintTool;
  onViewportChange: (viewport: ViewportState) => void;
  onAnnotate: (x: number, y: number, label: string, kind: 'text' | 'marker') => void;
  onCropChange?: (crop: PrintCrop) => void;
  onDropImage: (idx: number) => void;
  onClick: () => void;
  onSelectAnnotation?: (id: string) => void;
  onMoveAnnotation?: (id: string, x: number, y: number) => void;
  onRotateAnnotation?: (id: string) => void;
  onDeleteAnnotation?: (id: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number; viewport: ViewportState } | null>(null);
  const cropStartRef = useRef<{ x: number; y: number } | null>(null);
  const annotationDragId = useRef<string | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const displayedImage = useMemo(() => image ? croppedDicomImage(image, crop) : undefined, [image, crop]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      setCanvasSize({ width: rect.width, height: rect.height });
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (displayedImage) renderImage(ctx, displayedImage, viewport, rect.width, rect.height);
      else {
        ctx.fillStyle = '#020617';
        ctx.fillRect(0, 0, rect.width, rect.height);
      }
    };
    draw();
    // The print stylesheet resizes .pacs-print-sheet to fill the page, but the
    // canvas backing store keeps whatever resolution it had on screen unless
    // redrawn after that layout change - otherwise the raster just gets
    // stretched, looking zoomed/cropped on the printed page. The same problem
    // happens when the user switches the print layout (e.g. 1x1 -> 2x1):
    // that only changes the cell's CSS size, not image/viewport, so this
    // effect wouldn't otherwise rerun and the browser would stretch the old
    // bitmap to the new cell shape, visibly distorting the image. A
    // ResizeObserver catches any actual size change and redraws at the
    // correct resolution/aspect instead of letting the browser scale it.
    const resizeObserver = new ResizeObserver(() => draw());
    resizeObserver.observe(canvas);
    window.addEventListener('beforeprint', draw);
    window.addEventListener('afterprint', draw);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('beforeprint', draw);
      window.removeEventListener('afterprint', draw);
    };
  }, [displayedImage, viewport]);

  return <>
    <canvas
      ref={ref}
      className="h-full w-full"
      onClick={(event) => {
        onClick();
        if (!image || (activeTool !== 'markD' && activeTool !== 'markE' && activeTool !== 'text')) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const point = screenToImage(event.clientX - rect.left, event.clientY - rect.top, viewport, rect.width, rect.height, displayedImage?.width ?? image.width, displayedImage?.height ?? image.height);
        if (crop?.applied) { point.x += crop.x; point.y += crop.y; }
        const label = activeTool === 'text' ? window.prompt('Texto livre', '') : activeTool === 'markD' ? 'D' : 'E';
        if (label?.trim()) onAnnotate(point.x, point.y, label.trim(), activeTool === 'text' ? 'text' : 'marker');
      }}
      onMouseDown={(event) => {
        onClick();
        if (image && activeTool === 'crop' && onCropChange) {
          const rect = event.currentTarget.getBoundingClientRect();
          const point = screenToImage(event.clientX - rect.left, event.clientY - rect.top, viewport, rect.width, rect.height, image.width, image.height);
          cropStartRef.current = { x: Math.max(0, Math.min(image.width, point.x)), y: Math.max(0, Math.min(image.height, point.y)) };
          return;
        }
        dragRef.current = { x: event.clientX, y: event.clientY, viewport: { ...viewport } };
      }}
      onMouseMove={(event) => {
        if (image && cropStartRef.current && activeTool === 'crop' && onCropChange && event.buttons === 1) {
          const rect = event.currentTarget.getBoundingClientRect();
          const point = screenToImage(event.clientX - rect.left, event.clientY - rect.top, viewport, rect.width, rect.height, image.width, image.height);
          const endX = Math.max(0, Math.min(image.width, point.x));
          const endY = Math.max(0, Math.min(image.height, point.y));
          onCropChange({ x: Math.min(cropStartRef.current.x, endX), y: Math.min(cropStartRef.current.y, endY), width: Math.max(1, Math.abs(endX - cropStartRef.current.x)), height: Math.max(1, Math.abs(endY - cropStartRef.current.y)), applied: false });
          return;
        }
        if (!image || !dragRef.current || event.buttons !== 1) return;
        const dx = event.clientX - dragRef.current.x;
        const dy = event.clientY - dragRef.current.y;
        if (activeTool === 'zoom') onViewportChange({ ...dragRef.current.viewport, zoom: Math.max(0.05, dragRef.current.viewport.zoom * (1 + dy * 0.005)) });
        else if (activeTool === 'pan') onViewportChange({ ...dragRef.current.viewport, panX: dragRef.current.viewport.panX + dx, panY: dragRef.current.viewport.panY + dy });
        else if (activeTool === 'wl') onViewportChange({ ...dragRef.current.viewport, windowWidth: Math.max(1, dragRef.current.viewport.windowWidth + dx * 8), windowCenter: dragRef.current.viewport.windowCenter - dy * 8 });
      }}
      onMouseUp={() => { dragRef.current = null; cropStartRef.current = null; }}
      onMouseLeave={() => { dragRef.current = null; cropStartRef.current = null; }}
      onWheel={(event) => {
        if (!image) return;
        event.preventDefault();
        onViewportChange({ ...viewport, zoom: Math.max(0.05, viewport.zoom * (event.deltaY > 0 ? 0.9 : 1.1)) });
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const idx = Number(event.dataTransfer.getData('application/x-pacs-print-image-index'));
        if (Number.isFinite(idx)) onDropImage(idx);
      }}
    />
    {image && canvasSize.width > 0 && crop && !crop.applied && (() => {
      const start = imageToScreenPoint(crop.x, crop.y, viewport, canvasSize.width, canvasSize.height, image.width, image.height);
      const end = imageToScreenPoint(crop.x + crop.width, crop.y + crop.height, viewport, canvasSize.width, canvasSize.height, image.width, image.height);
      return <div className="pointer-events-none absolute border-2 border-dashed border-yellow-300 bg-yellow-300/10" style={{ left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y), boxShadow: '0 0 0 9999px rgba(0,0,0,.45)' }}/>;
    })()}
    {image && canvasSize.width > 0 && annotations.filter((annotation) => !crop?.applied || (annotation.x >= crop.x && annotation.x <= crop.x + crop.width && annotation.y >= crop.y && annotation.y <= crop.y + crop.height)).map((annotation) => {
      const annotationX = crop?.applied ? annotation.x - crop.x : annotation.x;
      const annotationY = crop?.applied ? annotation.y - crop.y : annotation.y;
      const renderImageValue = displayedImage ?? image;
      const point = imageToScreenPoint(annotationX, annotationY, viewport, canvasSize.width, canvasSize.height, renderImageValue.width, renderImageValue.height);
      return (
        <div
          key={annotation.id}
          className={`pacs-annotation group absolute flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-950 ${selectedAnnotationId === annotation.id ? 'ring-2 ring-yellow-300' : ''}`}
          style={{ left: point.x, top: point.y, transform: `translate(-50%, -50%) rotate(${annotation.rotation}deg)`, background: 'rgba(34, 211, 238, 0.9)', cursor: onMoveAnnotation ? 'grab' : 'default', touchAction: 'none', userSelect: 'none', fontSize: annotation.fontSize, fontFamily: annotationFontCss[annotation.fontFamily], fontWeight: annotation.bold ? 800 : 400, lineHeight: 1.05 }}
          onClick={(event) => { event.stopPropagation(); onSelectAnnotation?.(annotation.id); }}
          onPointerDown={(event) => {
            if (!onMoveAnnotation) return;
            event.stopPropagation();
            event.preventDefault();
            annotationDragId.current = annotation.id;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!onMoveAnnotation || annotationDragId.current !== annotation.id) return;
            const rect = ref.current?.getBoundingClientRect();
            if (!rect) return;
            const next = screenToImage(event.clientX - rect.left, event.clientY - rect.top, viewport, rect.width, rect.height, renderImageValue.width, renderImageValue.height);
            onMoveAnnotation(annotation.id, next.x + (crop?.applied ? crop.x : 0), next.y + (crop?.applied ? crop.y : 0));
          }}
          onPointerUp={(event) => {
            annotationDragId.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
        >
          {annotation.label}
          {onRotateAnnotation && (
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); onRotateAnnotation(annotation.id); }}
              onPointerDown={(event) => event.stopPropagation()}
              className="pacs-annotation-delete ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-950/70 text-cyan-100 opacity-0 transition-opacity group-hover:opacity-100"
              title="Girar 90 graus"
            >
              <RotateCw size={9} />
            </button>
          )}
          {onDeleteAnnotation && (
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); onDeleteAnnotation(annotation.id); }}
              onPointerDown={(event) => event.stopPropagation()}
              className="pacs-annotation-delete ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-950/70 text-cyan-100 opacity-0 transition-opacity group-hover:opacity-100"
              title="Remover anotacao"
            >
              <X size={9} />
            </button>
          )}
        </div>
      );
    })}
  </>;
}

export function PrintCenter({ store, mode = 'paper' }: { store: PacsStore; mode?: PrintMode }) {
  const isDicom = mode === 'dicom';
  const searchParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const requestedIds = useMemo(() => searchParams.get('studies')?.split(',').filter(Boolean) ?? [], [searchParams]);
  const queueOnly = isDicom && searchParams.get('queue') === '1' && !requestedIds.length;
  const selectedStudies = useMemo(() => requestedIds.length ? store.studies.filter((study) => requestedIds.includes(study.id)) : store.studies.slice(0, 1), [requestedIds, store.studies]);
  const firstStudy = selectedStudies[0] ?? store.studies[0];
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [regularPrinters, setRegularPrinters] = useState<LocalPrinter[]>([]);
  const [regularPrinterName, setRegularPrinterName] = useState('');
  const [printerKind, setPrinterKind] = useState<'dicom' | 'regular'>(isDicom ? 'dicom' : 'regular');
  const [layout, setLayout] = useState('1x1');
  const [copies, setCopies] = useState(1);
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [filmSize, setFilmSize] = useState('14INX17IN');
  const [sizeMode, setSizeMode] = useState<'fit' | 'true'>(firstStudy?.modality === 'MG' ? 'true' : 'fit');
  const [autoAdaptFilm, setAutoAdaptFilm] = useState(true);
  const [manualSpacingMm, setManualSpacingMm] = useState('');
  const [scope, setScope] = useState<'all' | 'selected'>(requestedIds.length ? 'selected' : 'all');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewImages, setPreviewImages] = useState<PrintPreviewImage[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [activeTool, setActiveTool] = useState<PrintTool>('wl');
  const [activeCell, setActiveCell] = useState(0);
  const [cellImageIdxs, setCellImageIdxs] = useState<number[]>(Array(9).fill(0));
  const [cellViewports, setCellViewports] = useState<Array<ViewportState | null>>(Array(9).fill(null));
  const [cellCrops, setCellCrops] = useState<Array<PrintCrop | null>>(Array(9).fill(null));
  const [annotations, setAnnotations] = useState<PrintAnnotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState('');
  const [annotationEditorOpen, setAnnotationEditorOpen] = useState(false);
  const [printerConfigOpen, setPrinterConfigOpen] = useState(false);
  const [printerDrafts, setPrinterDrafts] = useState<RemoteDevice[]>([]);
  const [printerSaving, setPrinterSaving] = useState(false);
  const [pendingPrinterId, setPendingPrinterId] = useState('');
  const [printJobs, setPrintJobs] = useState<PrintJob[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueStatus, setQueueStatus] = useState('');
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [tagEditorLoading, setTagEditorLoading] = useState(false);
  const [tagEditorSaving, setTagEditorSaving] = useState(false);
  const [tagValues, setTagValues] = useState<Record<string, string>>({});
  const [originalTagValues, setOriginalTagValues] = useState<Record<string, string>>({});
  const [tagMessage, setTagMessage] = useState('');

  const refreshQueue = async (showLoading = false) => {
    if (showLoading) setQueueLoading(true);
    try {
      const response = await apiFetch('/api/print-jobs');
      const rows = await response.json().catch(() => []);
      if (!response.ok) throw new Error(rows.error ?? 'Falha ao carregar fila de impressao.');
      setPrintJobs(Array.isArray(rows) ? rows : []);
      setQueueStatus('');
    } catch (error) {
      setQueueStatus(error instanceof Error ? error.message : 'Falha ao carregar fila de impressao.');
    } finally {
      if (showLoading) setQueueLoading(false);
    }
  };

  const refreshDevices = async () => {
    const response = await apiFetch('/api/dicom-printers');
    const rows = response.ok ? await response.json().catch(() => []) : [];
    const printerDevices = (Array.isArray(rows) ? rows : []) as RemoteDevice[];
    const activeDevices = printerDevices.filter((device) => device.enabled);
    setDevices(activeDevices);
    setPrinterDrafts(printerDevices);
    setDeviceId((current) => current && activeDevices.some((device) => String(device.id) === current) ? current : String(activeDevices[0]?.id ?? ''));
    return printerDevices;
  };

  const refreshRegularPrinters = async () => {
    try {
      const response = await apiFetch('/api/local-printers');
      const rows = await response.json().catch(() => []);
      const printers = Array.isArray(rows) ? rows as LocalPrinter[] : [];
      setRegularPrinters(printers);
      setRegularPrinterName((current) => {
        if (current && printers.some((printer) => printer.name === current)) return current;
        return printers.find((printer) => printer.isDefault)?.name ?? printers[0]?.name ?? '';
      });
    } catch {
      setRegularPrinters([]);
    }
  };

  useEffect(() => {
    refreshDevices().catch(() => undefined);
    refreshRegularPrinters().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (firstStudy?.modality === 'MG') setSizeMode('true');
  }, [firstStudy?.id, firstStudy?.modality]);

  useEffect(() => {
    if (!queueOnly) return;
    refreshQueue(true).catch(() => undefined);
    const interval = window.setInterval(() => refreshQueue().catch(() => undefined), 4000);
    return () => window.clearInterval(interval);
  }, [queueOnly]);

  const addPrinterDraft = () => {
    const id = crypto.randomUUID();
    setPendingPrinterId(id);
    setPrinterDrafts((current) => [...current, { id, kind: 'printer', aeTitle: 'DICOM_PRINT', callingAeTitle: store.config.aeTitle || 'PACSCHX', ip: '127.0.0.1', port: 104, description: 'Impressora DICOM', enabled: true }]);
  };

  const openAddPrinter = async () => {
    setPrinterKind('dicom');
    setPrinterConfigOpen(true);
    await refreshDevices().catch(() => undefined);
  };

  const updatePrinterDraft = (id: string, patch: Partial<RemoteDevice>) => {
    setPrinterDrafts((current) => current.map((device) => device.id === id ? { ...device, ...patch } : device));
  };

  const updatePrinterFilm = (deviceIdValue: string, filmSizeId: string, patch: Partial<PrinterFilmProfile>) => {
    setPrinterDrafts((current) => current.map((device) => {
      if (device.id !== deviceIdValue) return device;
      const films = printerFilms(device).map((film) => film.filmSizeId === filmSizeId ? { ...film, ...patch } : film);
      return { ...device, filmProfiles: films };
    }));
  };

  const updateCalibrationMeasurement = (deviceIdValue: string, film: PrinterFilmProfile, axis: 'width' | 'height', raw: string) => {
    const measured = Number(raw.replace(',', '.'));
    const calibration = { ...(film.calibration ?? {}) };
    if (axis === 'width') calibration.measuredWidthMm = measured > 0 ? measured : undefined;
    else calibration.measuredHeightMm = measured > 0 ? measured : undefined;
    calibration.factorX = calibration.measuredWidthMm ? film.widthMm / calibration.measuredWidthMm : undefined;
    calibration.factorY = calibration.measuredHeightMm ? film.heightMm / calibration.measuredHeightMm : undefined;
    calibration.validated = false;
    calibration.calibratedAt = new Date().toISOString();
    updatePrinterFilm(deviceIdValue, film.filmSizeId, { calibration });
  };

  const savePrinters = async () => {
    const remoteDevices = printerDrafts.map((device) => ({
      ...device,
      id: device.id || crypto.randomUUID(),
      kind: 'printer' as const,
      aeTitle: String(device.aeTitle ?? '').trim().toUpperCase(),
      callingAeTitle: String(device.callingAeTitle ?? store.config.aeTitle ?? 'PACSCHX').trim().toUpperCase(),
      ip: String(device.ip ?? '').trim(),
      port: Number(device.port),
      description: String(device.description ?? '').trim(),
      enabled: Boolean(device.enabled),
    }));
    const invalid = remoteDevices.find((device) => !device.aeTitle || !device.ip || device.port < 1 || device.port > 65535);
    if (invalid) { setStatus('Confira AE Title, IP e porta da impressora DICOM.'); return; }
    setPrinterSaving(true);
    try {
      const response = await apiFetch('/api/dicom-printers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ printers: remoteDevices }),
      });
      const saved = await response.json().catch(() => []);
      if (!response.ok) throw new Error(saved.error ?? 'Falha ao salvar impressoras DICOM.');
      const savedPrinters = (Array.isArray(saved) ? saved : remoteDevices).filter(isPrinterDevice);
      const activeDevices = savedPrinters.filter((device: RemoteDevice) => device.enabled);
      setPrinterDrafts(savedPrinters);
      setDevices(activeDevices);
      const nextDeviceId = pendingPrinterId && activeDevices.some((device: RemoteDevice) => String(device.id) === pendingPrinterId)
        ? pendingPrinterId
        : String(activeDevices[0]?.id ?? '');
      setDeviceId(nextDeviceId);
      setPendingPrinterId('');
      setPrinterConfigOpen(false);
      setStatus('Impressoras DICOM salvas.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Falha ao salvar impressoras DICOM.');
    } finally {
      setPrinterSaving(false);
    }
  };

  const activeLayout = layouts.find((item) => item.id === layout) ?? layouts[0];
  const targetStudies = scope === 'selected' ? selectedStudies : store.studies;
  const chosenDevice = devices.find((device) => String(device.id) === deviceId);
  const cellCount = activeLayout.rows * activeLayout.cols;
  const availableFilms = useMemo(() => printerFilms(chosenDevice), [chosenDevice]);
  const chosenFilm = availableFilms.find((film) => film.filmSizeId === filmSize) ?? nominalFilms.find((film) => film.filmSizeId === filmSize) ?? nominalFilms[5];
  const chosenCalibration = chosenFilm.calibration;
  const calibrationFactorX = Number(chosenCalibration?.factorX) || 1;
  const calibrationFactorY = Number(chosenCalibration?.factorY) || 1;

  const physicalSizeFor = useCallback((image?: PrintPreviewImage, crop?: PrintCrop | null) => {
    const manual = Number(manualSpacingMm.replace(',', '.'));
    const spacingX = image?.physicalSpacingX || (manual > 0 ? manual : 0);
    const spacingY = image?.physicalSpacingY || (manual > 0 ? manual : 0);
    const width = crop?.applied ? crop.width : image?.width;
    const height = crop?.applied ? crop.height : image?.height;
    return image && width && height && spacingX > 0 && spacingY > 0 ? { widthMm: width * spacingX, heightMm: height * spacingY, spacingX, spacingY } : null;
  }, [manualSpacingMm]);
  useEffect(() => {
    setActiveCell((cell) => Math.min(cell, Math.max(0, cellCount - 1)));
  }, [cellCount]);

  useEffect(() => {
    let cancelled = false;
    const study = targetStudies[0];
    setPreviewImages([]);
    setPreviewError('');
    if (!study) { setPreviewLoading(false); return; }
    setPreviewLoading(true);
    apiFetch(`/api/studies/${study.id}/viewer-data`)
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error ?? `Falha ao carregar imagens do estudo (${response.status}).`);
        return payload;
      })
      .then(async (payload) => {
        const instances = (payload.instances ?? []) as Array<{ id: number | string }>;
        if (!instances.length) throw new Error('O servidor nao encontrou imagens DICOM neste estudo.');
        const initial = payload.initialPixels ?? {};
        const images: PrintPreviewImage[] = new Array(instances.length);
        const failures: string[] = [];
        const loadOne = async (instance: { id: number | string }, index: number) => {
          const id = String(instance.id);
          let pixelPayload = initial[id];
          if (!pixelPayload) {
            const response = await apiFetch(`/api/instances/${id}/pixels`);
            pixelPayload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(pixelPayload.error ?? `Falha HTTP ${response.status} ao ler os pixels.`);
          }
          images[index] = { ...imageFromServerPixels(pixelPayload), instanceId: id };
        };

        const BATCH_SIZE = 6;
        for (let start = 0; start < instances.length; start += BATCH_SIZE) {
          const batch = instances.slice(start, start + BATCH_SIZE);
          const results = await Promise.allSettled(batch.map((instance, offset) => loadOne(instance, start + offset)));
          results.forEach((result, offset) => {
            if (result.status === 'rejected') failures.push(`Imagem ${String(batch[offset].id)}: ${result.reason instanceof Error ? result.reason.message : 'falha ao carregar pixels'}`);
          });
          if (!cancelled) setPreviewImages(images.filter(Boolean));
        }
        if (!cancelled && failures.length) setPreviewError(`${failures.length} de ${instances.length} imagens nao carregaram. ${failures.slice(0, 3).join(' | ')}`);
        else if (!cancelled && images.filter(Boolean).length < instances.length) setPreviewError('Algumas imagens DICOM nao puderam ser lidas.');
      })
      .catch((error) => { if (!cancelled) { setPreviewImages([]); setPreviewError(error instanceof Error ? error.message : 'Falha ao carregar imagens DICOM.'); } })
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [targetStudies, cellCount]);

  useEffect(() => {
    setCellImageIdxs((current) => current.map((idx, cell) => Math.min(previewImages.length - 1, idx || cell)).map((idx) => Math.max(0, idx)));
    setCellViewports((current) => current.map((viewport, cell) => viewport ?? (previewImages[cell] ? viewportFromImage(previewImages[cell]) : null)));
  }, [previewImages]);

  const fallbackViewport = previewImages[0] ? viewportFromImage(previewImages[0]) : {
    windowCenter: 40, windowWidth: 400, zoom: 1, panX: 0, panY: 0, invert: false, flipH: false, flipV: false, rotation: 0,
  };
  const activeImage = previewImages[cellImageIdxs[activeCell]] ?? previewImages[0];
  const activeCrop = cellCrops[activeCell];
  const selectedAnnotation = annotations.find((annotation) => annotation.id === selectedAnnotationId);
  const activeViewport = cellViewports[activeCell] ?? (activeImage ? viewportFromImage(activeImage) : fallbackViewport);
  const activePhysicalSize = physicalSizeFor(activeImage, activeCrop);
  const activeCropWidthMm = activeCrop && activePhysicalSize ? activeCrop.width * activePhysicalSize.spacingX : null;
  const activeCropHeightMm = activeCrop && activePhysicalSize ? activeCrop.height * activePhysicalSize.spacingY : null;
  const orientedFilm = orientation === 'portrait' ? { widthMm: chosenFilm.widthMm, heightMm: chosenFilm.heightMm } : { widthMm: chosenFilm.heightMm, heightMm: chosenFilm.widthMm };
  const cellWidthMm = Math.max(1, orientedFilm.widthMm / activeLayout.cols);
  const cellHeightMm = Math.max(1, (orientedFilm.heightMm - 12) / activeLayout.rows);
  const activeFitPercent = activePhysicalSize ? Math.min(cellWidthMm / activePhysicalSize.widthMm, cellHeightMm / activePhysicalSize.heightMm) * 100 : null;
  const activeTrueSizeFits = !activePhysicalSize || (activePhysicalSize.widthMm <= cellWidthMm && activePhysicalSize.heightMm <= cellHeightMm);
  const effectiveScalePercent = sizeMode === 'fit' ? activeFitPercent : 100;
  const scalePercentFor = (image: PrintPreviewImage | undefined, cell: number) => {
    const physical = physicalSizeFor(image, cellCrops[cell]);
    if (!physical) return null;
    return sizeMode === 'true' ? 100 : Math.min(cellWidthMm / physical.widthMm, cellHeightMm / physical.heightMm) * 100;
  };
  const calibrationStatus = chosenCalibration?.validated
    ? { tone: 'emerald', label: `Escala 100,0% validada em ${new Date(chosenCalibration.calibratedAt || Date.now()).toLocaleDateString('pt-BR')}` }
    : chosenCalibration?.factorX && chosenCalibration?.factorY
      ? { tone: 'amber', label: 'Escala 100% estimada (calibrada, nao validada)' }
      : { tone: 'red', label: 'Filme NAO calibrado: o tamanho fisico pode sair diferente do solicitado' };

  useEffect(() => {
    if (!autoAdaptFilm || sizeMode !== 'true' || !previewImages.length) return;
    const sizes = previewImages.slice(0, cellCount).map((image, index) => {
      const physical = physicalSizeFor(image, cellCrops[index]);
      if (!physical) return null;
      const rotation = Number(cellViewports[index]?.rotation) || 0;
      return rotation % 180 === 0 ? physical : { ...physical, widthMm: physical.heightMm, heightMm: physical.widthMm };
    }).filter(Boolean) as Array<{ widthMm: number; heightMm: number }>;
    if (!sizes.length) return;
    const requiredWidth = Math.max(...sizes.map((size) => size.widthMm)) * activeLayout.cols + 10;
    const requiredHeight = Math.max(...sizes.map((size) => size.heightMm)) * activeLayout.rows + 18;
    const candidate = [...availableFilms].sort((a, b) => a.widthMm * a.heightMm - b.widthMm * b.heightMm).find((film) => {
      const width = orientation === 'portrait' ? film.widthMm : film.heightMm;
      const height = orientation === 'portrait' ? film.heightMm : film.widthMm;
      return requiredWidth <= width && requiredHeight <= height;
    });
    if (candidate && candidate.filmSizeId !== filmSize) {
      setFilmSize(candidate.filmSizeId);
      setStatus(`Filme adaptado automaticamente para ${candidate.filmSizeId}.`);
    } else if (!candidate && firstStudy?.modality === 'MG') {
      setStatus('As imagens de mamografia nao cabem em tamanho real nos filmes cadastrados. Escolha um filme maior ou divida a impressao.');
    }
  }, [autoAdaptFilm, sizeMode, previewImages, cellCount, orientation, deviceId, manualSpacingMm, activeLayout.cols, activeLayout.rows, availableFilms, cellViewports, cellCrops, filmSize, firstStudy?.modality, physicalSizeFor]);

  useEffect(() => {
    if (!previewImages.length) return;
    setCellViewports((current) => current.map((viewport, cell) => {
      const image = previewImages[cellImageIdxs[cell]];
      if (!image) return viewport;
      const base = viewport ?? viewportFromImage(image);
      const physical = physicalSizeFor(image, cellCrops[cell]);
      if (sizeMode !== 'true' || !physical) return { ...base, zoom: 1 };
      const fitPercent = Math.min(cellWidthMm / physical.widthMm, cellHeightMm / physical.heightMm) * 100;
      return { ...base, zoom: Math.max(0.05, 100 / Math.max(fitPercent, 0.01)), panX: 0, panY: 0 };
    }));
  }, [sizeMode, filmSize, orientation, layout, previewImages, manualSpacingMm, cellHeightMm, cellImageIdxs, cellCrops, cellWidthMm, physicalSizeFor]);
  const activeInstanceId = activeImage?.instanceId;
  const dicomTagFields = [
    ['InstitutionName', 'Instituicao (0008,0080)', 'LO'], ['StudyDate', 'Data do exame (0008,0020)', 'DA'], ['StudyTime', 'Horario do exame (0008,0030)', 'TM'],
    ['PatientName', 'Nome do paciente (0010,0010)', 'PN'], ['PatientID', 'ID do paciente (0010,0020)', 'LO'], ['StudyDescription', 'Descricao do exame (0008,1030)', 'LO'],
    ['AccessionNumber', 'Numero de acesso (0008,0050)', 'SH'], ['ReferringPhysicianName', 'Medico solicitante (0008,0090)', 'PN'], ['PatientBirthDate', 'Nascimento (0010,0030)', 'DA'],
    ['PatientSex', 'Sexo (0010,0040)', 'CS'], ['Modality', 'Modalidade (0008,0060)', 'CS'], ['SeriesDescription', 'Descricao da serie (0008,103E)', 'LO'], ['BodyPartExamined', 'Regiao examinada (0018,0015)', 'CS'],
    ['PresentationSizeMode', 'Tamanho real (0070,0100)', 'CS', 'TRUE SIZE'],
  ] as const;
  const openTagEditor = async () => {
    if (!activeInstanceId) { setStatus('Selecione uma imagem na impressao.'); return; }
    setTagEditorOpen(true); setTagEditorLoading(true); setTagMessage('');
    try {
      const response = await apiFetch(`/api/instances/${activeInstanceId}/tags`);
      const values = await response.json();
      if (!response.ok) throw new Error(values.error ?? 'Falha ao ler tags DICOM.');
      const loaded = Object.fromEntries(dicomTagFields.map(([tag]) => [tag, Array.isArray(values[tag]) ? values[tag].join('\\') : String(values[tag] ?? '')]));
      const draft = Object.fromEntries(dicomTagFields.map(([tag, , , defaultValue]) => [tag, loaded[tag] || defaultValue || '']));
      setTagValues(draft);
      setOriginalTagValues(loaded);
    } catch (error) { setTagMessage(error instanceof Error ? error.message : 'Falha ao ler tags DICOM.'); }
    finally { setTagEditorLoading(false); }
  };
  const saveDicomTags = async () => {
    if (!activeInstanceId) return;
    setTagEditorSaving(true); setTagMessage('');
    try {
      const changedTags = Object.fromEntries(Object.entries(tagValues).filter(([tag, value]) => value !== originalTagValues[tag]));
      if (!Object.keys(changedTags).length) { setTagMessage('Nenhuma tag foi alterada.'); return; }
      const response = await apiFetch(`/api/instances/${activeInstanceId}/tags`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: changedTags }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Falha ao salvar tags DICOM.');
      await store.refreshData({ silent: true, includePatients: true, includeSeries: true });
      const freshTags = await apiFetch(`/api/instances/${activeInstanceId}/tags`).then((res) => res.ok ? res.json() : null);
      if (freshTags) {
        const loaded = Object.fromEntries(dicomTagFields.map(([tag]) => [tag, Array.isArray(freshTags[tag]) ? freshTags[tag].join('\\') : String(freshTags[tag] ?? '')]));
        const draft = Object.fromEntries(dicomTagFields.map(([tag, , , defaultValue]) => [tag, loaded[tag] || defaultValue || '']));
        setTagValues(draft);
        setOriginalTagValues(loaded);
      }
      setTagMessage(`Tags salvas. Backup criado ao lado do arquivo DICOM: ${String(result.backupPath).split(/[\\/]/).pop()}`);
      setStatus('Tags DICOM atualizadas com backup do arquivo original.');
    } catch (error) { setTagMessage(error instanceof Error ? error.message : 'Falha ao salvar tags DICOM.'); }
    finally { setTagEditorSaving(false); }
  };

  const setCellViewport = (cell: number, viewport: ViewportState) => {
    setCellViewports((current) => {
      const next = [...current];
      next[cell] = viewport;
      return next;
    });
  };

  const setCellImage = (cell: number, imageIdx: number) => {
    setCellImageIdxs((current) => {
      const next = [...current];
      next[cell] = Math.max(0, Math.min(imageIdx, Math.max(0, previewImages.length - 1)));
      return next;
    });
    const image = previewImages[imageIdx];
    if (image) setCellViewport(cell, viewportFromImage(image));
    setCellCrops((current) => current.map((crop, index) => index === cell ? null : crop));
  };

  const setCellCrop = (cell: number, crop: PrintCrop | null) => {
    setCellCrops((current) => current.map((value, index) => index === cell ? crop : value));
  };

  const updateActiveCrop = (patch: Partial<PrintCrop>) => {
    if (!activeImage) return;
    const current = activeCrop ?? { x: 0, y: 0, width: activeImage.width, height: activeImage.height, applied: false };
    const x = Math.max(0, Math.min(activeImage.width - 1, Number(patch.x ?? current.x)));
    const y = Math.max(0, Math.min(activeImage.height - 1, Number(patch.y ?? current.y)));
    const width = Math.max(1, Math.min(activeImage.width - x, Number(patch.width ?? current.width)));
    const height = Math.max(1, Math.min(activeImage.height - y, Number(patch.height ?? current.height)));
    setCellCrop(activeCell, { ...current, ...patch, x, y, width, height });
  };

  const applyCropToAll = () => {
    if (!activeImage || !activeCrop) return;
    const relative = { x: activeCrop.x / activeImage.width, y: activeCrop.y / activeImage.height, width: activeCrop.width / activeImage.width, height: activeCrop.height / activeImage.height };
    setCellCrops((current) => current.map((value, cell) => {
      if (cell >= cellCount) return value;
      const image = previewImages[cellImageIdxs[cell]];
      return image ? { x: relative.x * image.width, y: relative.y * image.height, width: relative.width * image.width, height: relative.height * image.height, applied: true } : value;
    }));
  };

  const applyActiveCrop = () => {
    if (!activeImage || !activeCrop) return;
    const nextCrop = { ...activeCrop, applied: true };
    setCellCrop(activeCell, nextCrop);
    const cropped = croppedDicomImage(activeImage, nextCrop);
    setCellViewport(activeCell, { ...activeViewport, zoom: 1, panX: 0, panY: 0, windowCenter: cropped.windowCenter, windowWidth: cropped.windowWidth } as ViewportState);
    setActiveTool('pan');
  };

  const moveAnnotation = (id: string, x: number, y: number) => {
    setAnnotations((current) => current.map((annotation) => annotation.id === id ? { ...annotation, x, y } : annotation));
  };

  const rotateAnnotation = (id: string) => {
    setAnnotations((current) => current.map((annotation) => annotation.id === id
      ? { ...annotation, rotation: (annotation.rotation + 90) % 360 }
      : annotation));
  };

  const updateAnnotation = (id: string, patch: Partial<PrintAnnotation>) => {
    setAnnotations((current) => current.map((annotation) => annotation.id === id ? { ...annotation, ...patch } : annotation));
  };

  const addAnnotation = (cell: number, x: number, y: number, label: string, kind: 'text' | 'marker') => {
    const id = `${Date.now()}_${Math.random()}`;
    setAnnotations((current) => [...current, { id, cell, x, y, label, kind, rotation: 0, fontSize: kind === 'marker' ? 30 : 18, fontFamily: kind === 'marker' ? 'wide' : 'standard', bold: true }]);
    setSelectedAnnotationId(id);
    setAnnotationEditorOpen(true);
  };

  const deleteAnnotation = (id: string) => {
    setAnnotations((current) => current.filter((annotation) => annotation.id !== id));
    setSelectedAnnotationId((current) => current === id ? '' : current);
    setAnnotationEditorOpen(false);
  };

  const submit = async () => {
    if (!targetStudies.length) { setStatus('Nenhum estudo disponivel para impressao.'); return; }
    if (printerKind === 'dicom' && !deviceId) { setStatus('Selecione uma impressora DICOM ativa.'); return; }
    if (printerKind === 'dicom' && !previewImages.length) { setStatus(previewError || 'Aguarde o carregamento das imagens antes de imprimir.'); return; }
    if (printerKind === 'dicom' && sizeMode === 'true' && !activePhysicalSize) { setStatus('Tamanho real exige Pixel Spacing DICOM ou um valor manual em mm/pixel.'); return; }
    if (printerKind === 'dicom' && firstStudy?.modality === 'MG' && sizeMode === 'true' && !chosenCalibration?.validated) { setStatus('Mamografia em tamanho real exige calibracao validada para este filme.'); return; }
    if (printerKind === 'dicom' && firstStudy?.modality === 'MG' && sizeMode === 'true' && !activeTrueSizeFits) { setStatus('Mamografia nao cabe neste filme em tamanho real. Escolha o filme maior sugerido ou divida as imagens.'); return; }
    setBusy(true);
    setStatus(printerKind === 'dicom' ? 'Enviando imagens DICOM...' : 'Preparando impressao regular...');
    try {
      if (printerKind === 'regular') {
        window.print();
        setStatus(`Impressao regular enviada ao sistema${regularPrinterName ? ` (${regularPrinterName})` : ''}.`);
        return;
      }
      let sent = 0;
      for (const study of targetStudies) {
        const printState = study.id === targetStudies[0]?.id ? {
          sizeMode,
          calibration: { factorX: calibrationFactorX, factorY: calibrationFactorY, validated: Boolean(chosenCalibration?.validated) },
          footerLines: dicomPrintFooterLines(study, sizeMode === 'true' ? 'TRUE SIZE' : 'SCALE TO FIT'),
          cells: Array.from({ length: cellCount }).map((_, cell) => {
            const image = previewImages[cellImageIdxs[cell]];
            const viewport = cellViewports[cell] ?? (image ? viewportFromImage(image) : null);
            const physical = physicalSizeFor(image, cellCrops[cell]);
            const crop = cellCrops[cell]?.applied ? cellCrops[cell] : null;
            const cellAnnotations = annotations.filter((annotation) => annotation.cell === cell).map(({ x, y, label, rotation, kind, fontSize, fontFamily, bold }) => ({
              x,
              y,
              label,
              rotation,
              kind,
              fontSize,
              fontFamily,
              bold,
            }));
            return image && viewport ? { cell, instanceId: image.instanceId, viewport: sizeMode === 'true' ? { ...viewport, zoom: 1 } : viewport, crop, annotations: cellAnnotations, physicalWidthMm: physical?.widthMm, physicalHeightMm: physical?.heightMm, spacingX: physical?.spacingX, spacingY: physical?.spacingY } : null;
          }).filter(Boolean),
        } : undefined;
        const create = await apiFetch('/api/print-jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ studyId: study.id, copies, printerName: chosenDevice?.aeTitle ?? 'DICOM Print', layout, orientation, filmSize }),
        });
        const job = await create.json();
        if (!create.ok) throw new Error(job.error ?? 'Falha ao criar job de impressao.');
        const send = await apiFetch(`/api/print-jobs/${job.id}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, layout, copies, orientation, filmSize, sizeMode, calibrationFactorX, calibrationFactorY, printState }),
        });
        const result = await send.json().catch(() => ({}));
        if (!send.ok) throw new Error(result.error ?? result.message ?? 'Falha no envio DICOM.');
        sent += 1;
      }
      setStatus(`${sent} estudo(s) enviado(s) para ${chosenDevice?.aeTitle ?? 'DICOM'}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Falha na impressao.');
    } finally {
      setBusy(false);
    }
  };

  if (queueOnly) {
    const counts = {
      queued: printJobs.filter((job) => job.status === 'queued').length,
      printing: printJobs.filter((job) => job.status === 'printing').length,
      printed: printJobs.filter((job) => job.status === 'printed').length,
      failed: printJobs.filter((job) => job.status === 'failed').length,
    };

    return <div className="flex h-full w-full items-center justify-center overflow-hidden bg-black p-5 text-white">
      <div className="flex h-[min(760px,calc(100vh-40px))] w-[min(980px,calc(100vw-40px))] flex-col overflow-hidden rounded-md border border-cyan-400/30 bg-[#172330] shadow-2xl shadow-black">
        <header className="flex items-center gap-3 border-b border-white/10 bg-[#0c1520] px-5 py-4">
          <Printer size={20} className="text-cyan-300" />
          <div>
            <div className="text-lg font-bold">Fila de Impressao DICOM</div>
            <div className="text-[11px] text-slate-400">Acompanhamento de jobs enviados para impressoras DICOM.</div>
          </div>
          <button onClick={() => void refreshQueue(true)} disabled={queueLoading} className="ml-auto flex items-center gap-2 rounded border border-cyan-400/40 px-3 py-2 text-xs font-bold text-cyan-100 hover:bg-cyan-400/10 disabled:opacity-50">
            <RotateCw size={14} className={queueLoading ? 'animate-spin' : ''} />
            Atualizar
          </button>
          <button onClick={() => window.close()} className="rounded border border-white/10 p-2 text-slate-300 hover:bg-white/10" title="Fechar"><X size={17} /></button>
        </header>

        <div className="grid grid-cols-4 gap-3 border-b border-white/10 bg-[#1d2a36] p-4">
          <div className="rounded border border-amber-400/20 bg-amber-400/10 p-3"><div className="text-[10px] font-bold uppercase text-amber-200">Na fila</div><div className="mt-1 text-2xl font-bold">{counts.queued}</div></div>
          <div className="rounded border border-cyan-400/20 bg-cyan-400/10 p-3"><div className="text-[10px] font-bold uppercase text-cyan-200">Enviando</div><div className="mt-1 text-2xl font-bold">{counts.printing}</div></div>
          <div className="rounded border border-emerald-400/20 bg-emerald-400/10 p-3"><div className="text-[10px] font-bold uppercase text-emerald-200">Enviados</div><div className="mt-1 text-2xl font-bold">{counts.printed}</div></div>
          <div className="rounded border border-red-400/20 bg-red-400/10 p-3"><div className="text-[10px] font-bold uppercase text-red-200">Falhas</div><div className="mt-1 text-2xl font-bold">{counts.failed}</div></div>
        </div>

        <main className="min-h-0 flex-1 overflow-auto p-4">
          {queueStatus && <div className="mb-3 rounded border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">{queueStatus}</div>}
          {!printJobs.length && !queueLoading ? <div className="grid h-full place-items-center rounded border border-dashed border-slate-600 text-center text-sm text-slate-400">Nenhum envio DICOM registrado na fila.</div> : (
            <div className="overflow-hidden rounded border border-white/10">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-[#0c1520] text-[11px] uppercase text-slate-400">
                  <tr><th className="px-3 py-2">Status</th><th className="px-3 py-2">Paciente / Exame</th><th className="px-3 py-2">Impressora</th><th className="px-3 py-2">Solicitado</th><th className="px-3 py-2">Finalizado</th></tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {printJobs.map((job) => {
                    const statusInfo = jobStatus(job);
                    const StatusIcon = statusInfo.icon;
                    return <tr key={job.id} className="bg-[#182637] align-top hover:bg-[#203145]">
                      <td className="px-3 py-3">
                        <span className={`inline-flex min-w-[104px] items-center gap-1.5 rounded border px-2 py-1 text-xs font-bold ${statusInfo.className}`}>
                          <StatusIcon size={14} className={job.status === 'printing' ? 'animate-spin' : ''} />
                          {statusInfo.label}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <div className="font-semibold text-slate-100">{patientName(String(job.patient_name ?? 'Paciente nao informado'))}</div>
                        <div className="mt-0.5 text-xs text-slate-400">{job.study_description || job.accession_number || job.modality || 'Exame sem descricao'}</div>
                        {job.error_message && <div className="mt-1 text-xs text-red-200">{job.error_message}</div>}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-cyan-100">{job.printer_name || '-'}</td>
                      <td className="px-3 py-3 text-xs text-slate-300">{formatJobDate(job.requested_at)}</td>
                      <td className="px-3 py-3 text-xs text-slate-300">{formatJobDate(job.printed_at || job.updated_at)}</td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
          )}
        </main>
      </div>
    </div>;
  }

  return <div className="pacs-print-center flex h-full w-full items-stretch justify-stretch overflow-hidden bg-black text-white">
    <div className="pacs-print-shell grid h-screen w-screen grid-cols-[minmax(560px,1.45fr)_minmax(440px,.9fr)] overflow-hidden border border-cyan-400/30 bg-[#253442] shadow-2xl shadow-black">
      <section className="pacs-print-preview flex min-h-0 flex-col border-r border-white/10 bg-[#172330]">
        <header className="pacs-print-ui flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div>
            <div className="text-lg font-bold">Imagem para impressao</div>
            <div className="text-[11px] text-slate-400">{firstStudy ? patientName(firstStudy.patientName) : 'Sem exame selecionado'}</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void openTagEditor()} disabled={!activeInstanceId} className="flex items-center gap-1.5 rounded border border-cyan-400/40 bg-cyan-400/10 px-2.5 py-1.5 text-xs font-bold text-cyan-100 hover:bg-cyan-400/20 disabled:opacity-40"><Tags size={14} />Editar tags DICOM</button>
            {previewLoading && <Loader2 className="animate-spin text-cyan-300" size={18} />}
          </div>
        </header>

        <div className="pacs-print-ui flex border-b border-white/10 bg-[#0c1520] px-2">
          {[
            { id: 'wl', label: 'Brilho', icon: <Contrast size={15} /> },
            { id: 'invert', label: 'Negativo', icon: <Moon size={15} /> },
            { id: 'zoom', label: 'Zoom', icon: <ZoomIn size={15} /> },
            { id: 'pan', label: 'Mover', icon: <Move size={15} /> },
            { id: 'crop', label: 'Corte', icon: <Scissors size={15} /> },
            { id: 'rotate', label: 'Girar', icon: <RotateCw size={15} /> },
            { id: 'markD', label: 'D', icon: <span className="text-sm font-black">D</span> },
            { id: 'markE', label: 'E', icon: <span className="text-sm font-black">E</span> },
            { id: 'text', label: 'Texto', icon: <Type size={15} /> },
            { id: 'fit', label: 'Ajustar', icon: <Maximize2 size={15} /> },
          ].map((tool) => (
            <button
              key={tool.id}
              onClick={() => {
                if (tool.id === 'zoom' && sizeMode === 'true') { setStatus('Zoom fica bloqueado no modo Tamanho real para preservar a escala fisica.'); return; }
                if (tool.id === 'crop' && activeCrop?.applied) setCellCrop(activeCell, { ...activeCrop, applied: false });
                if ((tool.id === 'text' || tool.id === 'markD' || tool.id === 'markE') && activeImage) {
                  const centerX = activeCrop?.applied ? activeCrop.x + activeCrop.width / 2 : activeImage.width / 2;
                  const centerY = activeCrop?.applied ? activeCrop.y + activeCrop.height / 2 : activeImage.height / 2;
                  addAnnotation(activeCell, centerX, centerY, tool.id === 'text' ? 'TEXTO' : tool.id === 'markD' ? 'D' : 'E', tool.id === 'text' ? 'text' : 'marker');
                  setActiveTool('pan');
                  return;
                }
                if (tool.id === 'rotate') setCellViewport(activeCell, { ...activeViewport, rotation: ((activeViewport.rotation + 90) % 360) } as ViewportState);
                else if (tool.id === 'invert') setCellViewport(activeCell, { ...activeViewport, invert: !activeViewport.invert } as ViewportState);
                else if (tool.id === 'fit' && previewImages[cellImageIdxs[activeCell]]) setCellViewport(activeCell, { ...viewportFromImage(previewImages[cellImageIdxs[activeCell]]), rotation: 0 } as ViewportState);
                else setActiveTool(tool.id as PrintTool);
              }}
              className={`my-1 flex min-w-[48px] flex-col items-center gap-1 rounded px-2 py-1 text-[9px] font-semibold ${activeTool === tool.id || (tool.id === 'invert' && activeViewport.invert) ? 'bg-cyan-500/20 text-cyan-200' : 'text-slate-300 hover:bg-white/10'}`}
              title={tool.label}
            >
              {tool.icon}
              <span>{tool.label}</span>
            </button>
          ))}
        </div>

        {previewError && <div role="alert" className="pacs-print-ui border-b border-amber-400/30 bg-amber-400/10 px-4 py-2 text-xs text-amber-100">{previewError}</div>}
        {(activeTool === 'crop' || activeCrop) && activeImage && <div className="pacs-print-ui flex flex-wrap items-end gap-2 border-b border-yellow-400/30 bg-yellow-400/10 px-3 py-2 text-[10px] text-yellow-50">
          <span className="mr-1 self-center font-bold uppercase">Corte</span>
          {(['x', 'y', 'width', 'height'] as const).map((field) => <label key={field} className="flex flex-col gap-0.5"><span>{field === 'width' ? 'Largura px' : field === 'height' ? 'Altura px' : field.toUpperCase()}</span><input type="number" min={field === 'width' || field === 'height' ? 1 : 0} value={Math.round(activeCrop?.[field] ?? (field === 'width' ? activeImage.width : field === 'height' ? activeImage.height : 0))} onChange={(event) => updateActiveCrop({ [field]: Number(event.target.value), applied: false })} className="w-20 rounded bg-[#0c1520] px-2 py-1 text-white outline-none ring-1 ring-yellow-300/40"/></label>)}
          <div className="min-w-24 self-center text-[10px] text-yellow-100">{activeCropWidthMm != null && activeCropHeightMm != null ? `${activeCropWidthMm.toFixed(1)} x ${activeCropHeightMm.toFixed(1)} mm` : 'Medida em mm indisponivel'}</div>
          <button onClick={applyActiveCrop} disabled={!activeCrop} className="rounded bg-yellow-400 px-3 py-1.5 font-bold text-slate-950 disabled:opacity-40">Aplicar</button>
          <button onClick={applyCropToAll} disabled={!activeCrop} className="rounded border border-yellow-300/50 px-3 py-1.5 font-bold disabled:opacity-40">Cortar tudo igual</button>
          <button onClick={() => setCellCrop(activeCell, null)} className="rounded border border-white/20 px-3 py-1.5">Reverter</button>
        </div>}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="pacs-print-stage flex flex-1 items-center justify-center p-5">
          <div className={`pacs-print-sheet ${orientation === 'portrait' ? 'pacs-print-portrait aspect-[10/13] h-full max-h-[calc(100vh-150px)]' : 'pacs-print-landscape aspect-[13/10] w-full max-w-[calc(100vw-640px)]'} flex flex-col rounded border border-slate-500 bg-black p-2 shadow-inner`}>
            <div className="grid min-h-0 flex-1 gap-2" style={{ gridTemplateColumns: `repeat(${activeLayout.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${activeLayout.rows}, minmax(0, 1fr))` }}>
              {Array.from({ length: cellCount }).map((_, index) => <div key={index} className="relative overflow-hidden rounded-sm border border-slate-700 bg-black">
                {previewImages[cellImageIdxs[index]] ? <PreviewCanvas
                  image={previewImages[cellImageIdxs[index]]}
                  viewport={cellViewports[index] ?? viewportFromImage(previewImages[cellImageIdxs[index]])}
                  annotations={annotations.filter((annotation) => annotation.cell === index)}
                  crop={cellCrops[index] ?? undefined}
                  selectedAnnotationId={selectedAnnotationId}
                  activeTool={activeTool}
                  onViewportChange={(nextViewport) => setCellViewport(index, nextViewport)}
                  onClick={() => setActiveCell(index)}
                  onDropImage={(idx) => setCellImage(index, idx)}
                  onAnnotate={(x, y, label, kind) => addAnnotation(index, x, y, label, kind)}
                  onSelectAnnotation={(id) => { setSelectedAnnotationId(id); setAnnotationEditorOpen(true); }}
                  onCropChange={(crop) => setCellCrop(index, crop)}
                  onMoveAnnotation={moveAnnotation}
                  onRotateAnnotation={rotateAnnotation}
                  onDeleteAnnotation={deleteAnnotation}
                /> : <div className="grid h-full place-items-center text-slate-600"><ImageIcon size={24} /></div>}
                <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[9px] text-cyan-200">{index + 1}</span>
                <span className={`absolute right-1 top-1 rounded px-1.5 py-0.5 text-[9px] font-bold ${scalePercentFor(previewImages[cellImageIdxs[index]], index) == null ? 'bg-red-500/90 text-white' : sizeMode === 'true' ? chosenCalibration?.validated ? 'bg-emerald-500/90 text-white' : 'bg-amber-500/90 text-black' : 'bg-cyan-500/90 text-slate-950'}`}>{scalePercentFor(previewImages[cellImageIdxs[index]], index) == null ? 'SEM SPACING' : `${scalePercentFor(previewImages[cellImageIdxs[index]], index)!.toFixed(1)}%`}</span>
              </div>)}
            </div>
            <div className="pacs-print-metadata mt-2 flex-shrink-0 border-t border-slate-700/80 bg-black pt-2 font-mono text-[8px] font-semibold uppercase leading-tight tracking-tight text-slate-100">
              {dicomPrintFooterLines(firstStudy, sizeMode === 'true' ? 'TRUE SIZE' : 'SCALE TO FIT').map((line, index) => (
                <div key={index} className="whitespace-normal break-words">
                  {line}
                </div>
              ))}
            </div>
          </div>
          </div>

          <aside className="pacs-print-ui flex w-[156px] flex-shrink-0 flex-col border-l border-white/10 bg-[#0c1520]">
            <div className="border-b border-white/10 px-2 py-2 text-[10px] font-bold uppercase tracking-wide text-cyan-200">Imagens</div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
              {previewImages.map((image, index) => (
                <button
                  key={`${image.instanceNumber}-${index}`}
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData('application/x-pacs-print-image-index', String(index))}
                  onClick={() => setCellImage(activeCell, index)}
                  className={`relative h-[104px] w-full overflow-hidden rounded border bg-black ${cellImageIdxs[activeCell] === index ? 'border-cyan-300' : 'border-slate-700 hover:border-slate-400'}`}
                >
                  <PreviewCanvas
                    image={image}
                    viewport={viewportFromImage(image)}
                    annotations={[]}
                    activeTool="wl"
                    onViewportChange={() => undefined}
                    onClick={() => undefined}
                    onDropImage={() => undefined}
                    onAnnotate={() => undefined}
                  />
                  <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-bold text-white">{index + 1}</span>
                </button>
              ))}
            </div>
          </aside>
        </div>

        <div className="pacs-print-ui border-t border-white/10 px-4 py-3 text-xs text-slate-300">
          {targetStudies.length} estudo(s), {targetStudies.reduce((sum, study) => sum + study.imageCount, 0)} imagem(ns)
        </div>
      </section>

      {annotationEditorOpen && selectedAnnotation && <div className="pacs-print-ui fixed inset-0 z-[70] grid place-items-center bg-black/75 p-4">
        <div className="w-[600px] max-w-full overflow-hidden rounded-lg border-2 border-cyan-400 bg-[#182637] shadow-2xl shadow-black">
          <header className="flex items-center border-b border-white/10 bg-[#0f1d2b] px-5 py-4">
            <div>
              <h2 className="text-lg font-bold text-cyan-100">Editar {selectedAnnotation.kind === 'marker' ? `marcador ${selectedAnnotation.label}` : 'texto'}</h2>
              <p className="mt-1 text-xs text-slate-300">Altere abaixo. Depois, arraste o item na imagem para posicionar.</p>
            </div>
            <button onClick={() => setAnnotationEditorOpen(false)} className="ml-auto rounded p-2 text-slate-300 hover:bg-white/10" title="Fechar"><X size={19}/></button>
          </header>

          <div className="space-y-5 p-5">
            <label className="block text-sm font-bold text-slate-200">
              Texto
              <input autoFocus value={selectedAnnotation.label} onChange={(event) => updateAnnotation(selectedAnnotation.id, { label: event.target.value.slice(0, 160) })} className="mt-2 w-full rounded border border-slate-500 bg-[#08131f] px-3 py-2.5 text-base text-white outline-none focus:border-cyan-300"/>
            </label>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="block text-sm font-bold text-slate-200">
                Tipo de fonte
                <select value={selectedAnnotation.fontFamily} onChange={(event) => updateAnnotation(selectedAnnotation.id, { fontFamily: event.target.value as AnnotationFont })} className="mt-2 w-full rounded border border-slate-500 bg-[#08131f] px-3 py-2.5 text-white outline-none focus:border-cyan-300">
                  <option value="standard">Padrao</option><option value="compact">Compacta</option><option value="wide">Larga</option><option value="mono">Monoespacada</option>
                </select>
              </label>
              <div className="text-sm font-bold text-slate-200">
                Tamanho da fonte
                <div className="mt-2 flex h-[42px] items-stretch">
                  <button onClick={() => updateAnnotation(selectedAnnotation.id, { fontSize: Math.max(8, selectedAnnotation.fontSize - 2) })} className="w-12 rounded-l bg-[#33485d] text-xl hover:bg-[#405a72]" title="Diminuir">−</button>
                  <input type="number" min="8" max="96" value={selectedAnnotation.fontSize} onChange={(event) => updateAnnotation(selectedAnnotation.id, { fontSize: Math.max(8, Math.min(96, Number(event.target.value) || 8)) })} className="min-w-0 flex-1 border-y border-slate-500 bg-[#08131f] px-2 text-center text-lg text-white outline-none"/>
                  <button onClick={() => updateAnnotation(selectedAnnotation.id, { fontSize: Math.min(96, selectedAnnotation.fontSize + 2) })} className="w-12 rounded-r bg-cyan-500 text-xl font-black text-slate-950 hover:bg-cyan-400" title="Aumentar">+</button>
                </div>
              </div>
            </div>

            <div className="rounded border border-cyan-400/30 bg-[#0b1724] p-4">
              <div className="mb-3 flex items-center justify-between"><span className="text-sm font-bold text-slate-200">Girar livremente</span><strong className="rounded bg-cyan-400 px-3 py-1 text-base text-slate-950">{Math.round(selectedAnnotation.rotation)} graus</strong></div>
              <input aria-label="Rotacao livre" type="range" min="0" max="359" step="1" value={selectedAnnotation.rotation} onChange={(event) => updateAnnotation(selectedAnnotation.id, { rotation: Number(event.target.value) })} className="h-3 w-full cursor-pointer accent-cyan-400"/>
              <div className="mt-3 grid grid-cols-4 gap-2">
                <button onClick={() => updateAnnotation(selectedAnnotation.id, { rotation: (selectedAnnotation.rotation + 345) % 360 })} className="rounded bg-[#33485d] px-2 py-2 font-bold hover:bg-[#405a72]">−15 graus</button>
                <button onClick={() => updateAnnotation(selectedAnnotation.id, { rotation: (selectedAnnotation.rotation + 15) % 360 })} className="rounded bg-[#33485d] px-2 py-2 font-bold hover:bg-[#405a72]">+15 graus</button>
                <button onClick={() => updateAnnotation(selectedAnnotation.id, { rotation: (selectedAnnotation.rotation + 90) % 360 })} className="rounded bg-[#33485d] px-2 py-2 font-bold hover:bg-[#405a72]">+90 graus</button>
                <input aria-label="Angulo em graus" type="number" min="0" max="359" value={Math.round(selectedAnnotation.rotation)} onChange={(event) => updateAnnotation(selectedAnnotation.id, { rotation: ((Number(event.target.value) % 360) + 360) % 360 })} className="min-w-0 rounded border border-slate-500 bg-[#08131f] px-2 text-center text-white outline-none focus:border-cyan-300"/>
              </div>
            </div>

            <label className="flex cursor-pointer items-center gap-3 rounded border border-white/10 bg-white/5 px-4 py-3 text-sm font-bold text-slate-200"><input type="checkbox" checked={selectedAnnotation.bold} onChange={(event) => updateAnnotation(selectedAnnotation.id, { bold: event.target.checked })} className="h-5 w-5 accent-cyan-400"/> Usar texto em negrito</label>
          </div>

          <footer className="flex items-center gap-2 border-t border-white/10 bg-[#0f1d2b] px-5 py-4">
            <button onClick={() => deleteAnnotation(selectedAnnotation.id)} className="rounded border border-red-400/50 px-4 py-2 text-sm font-bold text-red-200 hover:bg-red-500/10">Excluir</button>
            <button onClick={() => setAnnotationEditorOpen(false)} className="ml-auto rounded bg-cyan-500 px-6 py-2 text-sm font-black text-slate-950 hover:bg-cyan-400">Concluido</button>
          </footer>
        </div>
      </div>}

      {tagEditorOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
        <div className="flex max-h-[90vh] w-[760px] max-w-full flex-col overflow-hidden rounded-md border border-cyan-400/30 bg-[#182637] shadow-2xl">
          <header className="flex items-center border-b border-white/10 px-5 py-4"><div><h2 className="font-bold text-cyan-100">Editar tags DICOM</h2><p className="mt-1 text-xs text-slate-400">Imagem selecionada Â· valores DA em AAAAMMDD e TM em HHMMSS.fracao</p></div><button onClick={() => setTagEditorOpen(false)} className="ml-auto rounded p-2 text-slate-300 hover:bg-white/10"><X size={17} /></button></header>
          {tagEditorLoading ? <div className="p-8 text-center text-sm text-slate-300">Lendo tags do arquivo...</div> : <div className="grid min-h-0 grid-cols-2 gap-3 overflow-y-auto p-5">
            {dicomTagFields.map(([tag, label, vr]) => <label key={tag} className="flex flex-col gap-1 text-xs font-semibold text-slate-300"><span>{label} <span className="font-mono text-slate-500">{vr}</span></span><input value={tagValues[tag] ?? ''} onChange={(event) => setTagValues((current) => ({ ...current, [tag]: event.target.value }))} maxLength={vr === 'DA' ? 8 : undefined} className="rounded border border-slate-600 bg-[#0c1520] px-3 py-2 text-sm text-white outline-none focus:border-cyan-400" /></label>)}
          </div>}
          {tagMessage && <div className="border-t border-white/10 px-5 py-3 text-xs text-cyan-100 break-all">{tagMessage}</div>}
          <footer className="flex items-center gap-2 border-t border-white/10 px-5 py-3"><span className="text-[11px] text-slate-400">O arquivo original sera preservado em .bak</span><button onClick={() => setTagEditorOpen(false)} className="ml-auto rounded bg-[#394b5e] px-4 py-2 text-xs font-bold">Cancelar</button><button onClick={() => void saveDicomTags()} disabled={tagEditorLoading || tagEditorSaving} className="flex items-center gap-2 rounded bg-cyan-500 px-4 py-2 text-xs font-bold text-slate-950 disabled:opacity-50">{tagEditorSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}Salvar tags</button></footer>
        </div>
      </div>}
      <section className="pacs-print-ui flex min-w-0 flex-col">
        <header className="flex items-center border-b border-white/10 bg-[#1d2a36] px-5 py-3">
          <div>
            <div className="text-xl font-bold">Detalhes da Impressao</div>
            <div className="mt-0.5 text-[11px] text-slate-300">{firstStudy ? firstStudy.studyDescription : 'Selecione um exame na Worklist'}</div>
          </div>
          <button onClick={() => window.close()} className="ml-auto rounded border border-white/10 p-2 text-slate-300 hover:bg-white/10" title="Fechar"><X size={17} /></button>
        </header>

        <main className="min-h-0 flex-1 overflow-auto px-6 py-5">
          <div className="space-y-4 text-sm">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <label className="block font-semibold">Impressora</label>
                <button onClick={() => void openAddPrinter()} className="ml-auto flex items-center gap-1.5 rounded border border-cyan-400/40 bg-cyan-400/10 px-3 py-1.5 text-xs font-bold text-cyan-100 hover:bg-cyan-400/20">
                  <Plus size={14} /> Adicionar impressora DICOM
                </button>
              </div>
              <div className="mb-0 flex w-fit overflow-hidden rounded-t border border-slate-500/70">
                <button onClick={() => setPrinterKind('dicom')} className={`px-7 py-2 font-bold ${printerKind === 'dicom' ? 'bg-[#6c8296]' : 'bg-[#223140] text-slate-200'}`}>DICOM</button>
                <button onClick={() => setPrinterKind('regular')} className={`border-l border-slate-500/70 px-7 py-2 font-bold ${printerKind === 'regular' ? 'bg-[#6c8296]' : 'bg-[#223140] text-slate-200'}`}>Regular</button>
              </div>
              <div className="flex h-11 items-center border-2 border-cyan-500/70 bg-[#0c1520] px-3 font-bold shadow-inner">
                {printerKind === 'dicom'
                  ? <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)} className="w-full bg-transparent text-sm outline-none">
                    {devices.map((device) => <option key={device.id} value={device.id} style={{ backgroundColor: '#0c1520', color: '#fff' }}>{device.aeTitle} ({device.ip}:{device.port})</option>)}
                  </select>
                  : <select value={regularPrinterName} onChange={(event) => setRegularPrinterName(event.target.value)} className="w-full bg-transparent text-sm outline-none">
                    {regularPrinters.length
                      ? regularPrinters.map((printer) => <option key={printer.name} value={printer.name} style={{ backgroundColor: '#0c1520', color: '#fff' }}>{printer.name}{printer.isDefault ? ' (padrao)' : ''}</option>)
                      : <option value="" style={{ backgroundColor: '#0c1520', color: '#fff' }}>Nenhuma impressora encontrada</option>}
                  </select>}
                <ChevronDown className="ml-2 text-slate-300" size={18} />
              </div>
              {printerKind === 'dicom' && !devices.length && <div className="mt-1 text-xs text-amber-300">Cadastre uma impressora DICOM nesta tela para seleciona-la em seguida.</div>}
              {printerKind === 'regular' && !regularPrinters.length && <div className="mt-1 text-xs text-amber-300">Nenhuma impressora local foi retornada pelo Windows. O dialogo do sistema ainda pode permitir escolher manualmente.</div>}
            </div>

            <div>
              <label className="mb-2 block font-semibold">Layout</label>
              <div className="grid grid-cols-5 gap-2">
                {layouts.map((item) => {
                  const Icon = item.icon;
                  return <button key={item.id} onClick={() => setLayout(item.id)} className={`flex h-16 flex-col items-center justify-center gap-1 rounded border ${layout === item.id ? 'border-cyan-300 bg-[#162635] text-cyan-200' : 'border-transparent bg-[#304152] text-slate-100 hover:bg-white/5'}`}>
                    <Icon size={24} strokeWidth={1.8} />
                    <span className="text-[11px] font-semibold">{item.label}</span>
                  </button>;
                })}
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs">
                <span>Linhas:</span><div className="w-10 rounded bg-[#415265] py-1 text-center">{activeLayout.rows}</div>
                <span>Colunas:</span><div className="w-10 rounded bg-[#415265] py-1 text-center">{activeLayout.cols}</div>
              </div>
            </div>

            <div className={`grid gap-3 ${printerKind === 'dicom' ? 'grid-cols-2' : 'grid-cols-1'}`}>
              <label className="block">
                <span className="mb-2 block font-semibold">Copias</span>
                <div className="flex h-10 items-center rounded bg-[#243241]">
                  <button onClick={() => setCopies((value) => Math.max(1, value - 1))} className="h-full w-10 text-lg">-</button>
                  <input value={copies} onChange={(event) => setCopies(Math.max(1, Number(event.target.value) || 1))} className="min-w-0 flex-1 bg-transparent text-center font-bold outline-none" />
                  <button onClick={() => setCopies((value) => value + 1)} className="h-full w-10 text-lg">+</button>
                </div>
              </label>
              {printerKind === 'dicom' && (
                <label className="block">
                  <span className="mb-2 block font-semibold">Tamanho</span>
                  <select value={filmSize} onChange={(event) => setFilmSize(event.target.value)} className="h-10 w-full rounded bg-[#263645] px-3 font-bold outline-none">
                    {availableFilms.map((film) => <option key={film.filmSizeId} value={film.filmSizeId} style={{ backgroundColor: '#263645', color: '#fff' }}>{film.filmSizeId}</option>)}
                  </select>
                </label>
              )}
            </div>

            {printerKind === 'dicom' && <div className="space-y-2 rounded border border-slate-500/50 bg-[#182737] p-3">
              <div className="flex items-center justify-between"><span className="font-semibold">Escala da imagem</span><button onClick={() => setPrinterConfigOpen(true)} className="rounded border border-cyan-400/40 px-2 py-1 text-[11px] font-bold text-cyan-100 hover:bg-cyan-400/10">Calibracao</button></div>
              <div className="grid grid-cols-2 overflow-hidden rounded border border-slate-500/60">
                <button onClick={() => setSizeMode('fit')} className={`py-2 text-xs font-bold ${sizeMode === 'fit' ? 'bg-cyan-500 text-slate-950' : 'bg-[#304152]'}`}>Ajustar ao filme</button>
                <button onClick={() => setSizeMode('true')} className={`border-l border-slate-500/60 py-2 text-xs font-bold ${sizeMode === 'true' ? 'bg-cyan-500 text-slate-950' : 'bg-[#304152]'}`}>Tamanho real</button>
              </div>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={autoAdaptFilm} onChange={(event) => setAutoAdaptFilm(event.target.checked)}/> Adaptar automaticamente para o menor filme onde cabe</label>
              {sizeMode === 'true' && !activePhysicalSize && <label className="block text-xs text-amber-200">Pixel Spacing ausente. Informe manualmente (mm/pixel):<input value={manualSpacingMm} onChange={(event) => setManualSpacingMm(event.target.value)} placeholder="Ex.: 0,10" className="mt-1 w-full rounded bg-[#0c1520] px-3 py-2 text-white outline-none ring-1 ring-amber-400/50"/></label>}
              <div className={`rounded border px-3 py-2 text-xs font-bold ${calibrationStatus.tone === 'emerald' ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-200' : calibrationStatus.tone === 'amber' ? 'border-amber-400/50 bg-amber-400/10 text-amber-100' : 'border-red-400/50 bg-red-400/10 text-red-200'}`}>
                {sizeMode === 'true' ? calibrationStatus.label : `Escala ajustada: ${effectiveScalePercent != null ? effectiveScalePercent.toFixed(1) : '-'}%`}
                <div className="mt-1 font-normal opacity-80">Filme {chosenFilm.filmSizeId} · fator X {calibrationFactorX.toFixed(4)} · fator Y {calibrationFactorY.toFixed(4)}</div>
              </div>
            </div>}

            <div>
              <label className="mb-2 block font-semibold">Orientacao</label>
              <div className="grid grid-cols-2 overflow-hidden rounded border border-slate-500/60">
                <button onClick={() => setOrientation('portrait')} className={`py-3 font-bold ${orientation === 'portrait' ? 'bg-[#7f95aa] text-cyan-100' : 'bg-[#334556]'}`}>Retrato</button>
                <button onClick={() => setOrientation('landscape')} className={`border-l border-slate-500/60 py-3 font-bold ${orientation === 'landscape' ? 'bg-[#7f95aa] text-cyan-100' : 'bg-[#334556]'}`}>Paisagem</button>
              </div>
            </div>

            <div>
              <label className="mb-2 block font-semibold">Imprimir</label>
              <div className="grid grid-cols-2 gap-3">
                <button onClick={() => setScope('all')} className={`rounded border py-3 font-bold ${scope === 'all' ? 'border-cyan-300 bg-[#8da1b3]' : 'border-slate-500/60 bg-[#6f8192]'}`}>Todas</button>
                <button onClick={() => setScope('selected')} className={`rounded border py-3 font-bold ${scope === 'selected' ? 'border-cyan-300 bg-[#8da1b3]' : 'border-slate-500/60 bg-[#6f8192]'}`}>Selecionadas</button>
              </div>
            </div>
          </div>
        </main>

        <footer className="flex min-h-16 items-center gap-3 border-t border-white/10 bg-[#1f2c38] px-5">
          <div className="min-w-0 flex-1 truncate text-xs text-slate-300">{status || `${layout}, ${copies} copia(s), ${orientation === 'portrait' ? 'retrato' : 'paisagem'}`}</div>
          <button onClick={() => window.close()} className="rounded bg-[#394b5e] px-5 py-2 text-sm font-bold text-slate-100 hover:bg-[#465b70]">Cancelar</button>
          <button disabled={busy || (printerKind === 'dicom' && !deviceId)} onClick={() => void submit()} className="flex min-w-32 items-center justify-center gap-2 rounded bg-cyan-500 px-5 py-2 text-sm font-bold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40">
            {busy ? <Loader2 className="animate-spin" size={16} /> : printerKind === 'dicom' ? <Send size={16} /> : <Printer size={16} />}
            Imprimir
          </button>
        </footer>
      </section>
    </div>
    {printerConfigOpen && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5">
        <div className="flex max-h-[86vh] w-[820px] max-w-[calc(100vw-40px)] flex-col overflow-hidden rounded-md border border-cyan-400/30 bg-[#182637] shadow-2xl">
          <header className="flex items-center gap-3 border-b border-white/10 bg-[#0c1520] px-5 py-4">
            <Settings size={18} className="text-cyan-300" />
            <div>
              <div className="text-base font-bold">Impressoras DICOM</div>
              <div className="text-[11px] text-slate-400">Cadastre AE Title, IP e porta para envio DICOM Print.</div>
            </div>
            <button onClick={() => setPrinterConfigOpen(false)} className="ml-auto rounded p-2 text-slate-300 hover:bg-white/10"><X size={17} /></button>
          </header>

          <main className="min-h-0 flex-1 overflow-auto p-4">
            <div className="space-y-3">
              {printerDrafts.map((device) => (
                <div key={device.id} className="rounded border border-slate-600 bg-[#213143] p-3">
                  <div className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_84px_1.1fr_auto]">
                    <input value={device.aeTitle} onChange={(event) => updatePrinterDraft(device.id, { aeTitle: event.target.value.toUpperCase() })} placeholder="AE IMPRESSORA" title="AE Title chamado na impressora" className="min-w-0 rounded bg-[#0c1520] px-3 py-2 text-sm font-mono outline-none ring-1 ring-slate-600 focus:ring-cyan-400" />
                    <input value={device.callingAeTitle ?? store.config.aeTitle ?? 'PACSCHX'} onChange={(event) => updatePrinterDraft(device.id, { callingAeTitle: event.target.value.toUpperCase() })} placeholder="AE LOCAL" title="AE Title de origem autorizado na impressora" className="min-w-0 rounded bg-[#0c1520] px-3 py-2 text-sm font-mono outline-none ring-1 ring-slate-600 focus:ring-cyan-400" />
                    <input value={device.ip} onChange={(event) => updatePrinterDraft(device.id, { ip: event.target.value })} placeholder="IP" className="min-w-0 rounded bg-[#0c1520] px-3 py-2 text-sm font-mono outline-none ring-1 ring-slate-600 focus:ring-cyan-400" />
                    <input value={device.port} onChange={(event) => updatePrinterDraft(device.id, { port: Number(event.target.value) })} type="number" placeholder="Porta" className="min-w-0 rounded bg-[#0c1520] px-2 py-2 text-sm outline-none ring-1 ring-slate-600 focus:ring-cyan-400 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
                    <input value={device.description} onChange={(event) => updatePrinterDraft(device.id, { description: event.target.value })} placeholder="Descricao" className="min-w-0 rounded bg-[#0c1520] px-3 py-2 text-sm outline-none ring-1 ring-slate-600 focus:ring-cyan-400" />
                    <button onClick={() => setPrinterDrafts((current) => current.filter((item) => item.id !== device.id))} className="flex-shrink-0 rounded p-2 text-slate-300 hover:bg-red-500/10 hover:text-red-300" title="Remover"><Trash2 size={16} /></button>
                  </div>
                  <label className="mt-3 flex w-fit items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={device.enabled} onChange={(event) => updatePrinterDraft(device.id, { enabled: event.target.checked })} />
                    Ativa para impressao DICOM
                  </label>
                  <div className="mt-3 grid gap-2 border-t border-slate-600 pt-3 md:grid-cols-3">
                    <input value={device.brand ?? ''} onChange={(event) => updatePrinterDraft(device.id, { brand: event.target.value })} placeholder="Marca" className="rounded bg-[#0c1520] px-3 py-2 text-xs outline-none ring-1 ring-slate-600"/>
                    <input value={device.model ?? ''} onChange={(event) => updatePrinterDraft(device.id, { model: event.target.value })} placeholder="Modelo" className="rounded bg-[#0c1520] px-3 py-2 text-xs outline-none ring-1 ring-slate-600"/>
                    <input value={device.firmware ?? ''} onChange={(event) => updatePrinterDraft(device.id, { firmware: event.target.value })} placeholder="Firmware (a confirmar)" className="rounded bg-[#0c1520] px-3 py-2 text-xs outline-none ring-1 ring-slate-600"/>
                  </div>
                  <div className="mt-3 overflow-auto rounded border border-slate-600">
                    <div className="bg-[#0c1520] px-3 py-2 text-xs font-bold text-cyan-100">Calibracao de tamanho — informe a medida obtida com regua</div>
                    <table className="w-full min-w-[700px] text-left text-[11px]"><thead className="bg-[#26384a] text-slate-300"><tr><th className="px-2 py-2">Filme nominal</th><th>Medido X (mm)</th><th>Medido Y (mm)</th><th>Escala sem correcao</th><th>Fatores</th><th>Validacao</th></tr></thead><tbody>{printerFilms(device).map((film) => {
                      const calibration = film.calibration ?? {};
                      const rawScaleX = calibration.factorX ? 100 / calibration.factorX : null;
                      const rawScaleY = calibration.factorY ? 100 / calibration.factorY : null;
                      return <tr key={film.filmSizeId} className="border-t border-slate-600"><td className="px-2 py-2 font-bold">{film.filmSizeId}<div className="font-normal text-slate-400">{film.widthMm} x {film.heightMm} mm</div></td><td><input value={calibration.measuredWidthMm ?? ''} onChange={(event) => updateCalibrationMeasurement(device.id, film, 'width', event.target.value)} placeholder="a confirmar" className="w-24 rounded bg-[#0c1520] px-2 py-1 outline-none ring-1 ring-slate-600"/></td><td><input value={calibration.measuredHeightMm ?? ''} onChange={(event) => updateCalibrationMeasurement(device.id, film, 'height', event.target.value)} placeholder="a confirmar" className="w-24 rounded bg-[#0c1520] px-2 py-1 outline-none ring-1 ring-slate-600"/></td><td>{rawScaleX && rawScaleY ? `${rawScaleX.toFixed(1)}% / ${rawScaleY.toFixed(1)}%` : 'Nao calibrado'}</td><td>X {Number(calibration.factorX || 1).toFixed(4)}<br/>Y {Number(calibration.factorY || 1).toFixed(4)}</td><td><button disabled={!calibration.factorX || !calibration.factorY} onClick={() => updatePrinterFilm(device.id, film.filmSizeId, { calibration: { ...calibration, validated: !calibration.validated, calibratedAt: new Date().toISOString() } })} className={`rounded px-2 py-1 font-bold disabled:opacity-30 ${calibration.validated ? 'bg-emerald-500 text-slate-950' : 'bg-amber-500 text-slate-950'}`}>{calibration.validated ? 'Validada' : 'Validar'}</button></td></tr>;
                    })}</tbody></table>
                  </div>
                </div>
              ))}
              {!printerDrafts.length && <div className="rounded border border-dashed border-slate-600 p-5 text-center text-sm text-slate-400">Nenhuma impressora DICOM cadastrada.</div>}
            </div>
          </main>

          <footer className="flex items-center gap-3 border-t border-white/10 bg-[#0c1520] px-5 py-4">
            <button onClick={addPrinterDraft} className="flex items-center gap-2 rounded border border-dashed border-cyan-300/40 px-4 py-2 text-sm font-bold text-cyan-100 hover:bg-cyan-400/10"><Plus size={15} />Adicionar impressora</button>
            <button onClick={() => setPrinterConfigOpen(false)} className="ml-auto rounded bg-[#394b5e] px-5 py-2 text-sm font-bold hover:bg-[#465b70]">Cancelar</button>
            <button onClick={() => void savePrinters()} disabled={printerSaving} className="flex items-center gap-2 rounded bg-cyan-500 px-5 py-2 text-sm font-bold text-slate-950 hover:bg-cyan-300 disabled:opacity-50">
              {printerSaving ? <Loader2 className="animate-spin" size={15} /> : <Save size={15} />}
              Salvar
            </button>
          </footer>
        </div>
      </div>
    )}
  </div>;
}
