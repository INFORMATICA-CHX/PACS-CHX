import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Contrast, Maximize2, Moon,
  AlertTriangle, CheckCircle2, ChevronDown, Clock3, Grid2X2, Grid3X3, Image as ImageIcon, LayoutPanelLeft,
  Loader2, Move, Plus, Printer, RotateCw, Rows3, Save, Send, Settings, Square, Trash2, Type, X, ZoomIn,
} from 'lucide-react';
import type { DicomImage, Study } from '@/types';
import type { PacsStore } from '@/lib/usePacsStore';
import { apiFetch } from '@/lib/apiClient';
import { renderImage, screenToImage, type ViewportState, viewportFromImage } from '@/lib/dicomViewer';

type PrintMode = 'dicom' | 'paper';
type PrintTool = 'wl' | 'zoom' | 'pan' | 'markD' | 'markE' | 'text';
type PrintAnnotation = { id: string; cell: number; x: number; y: number; label: string };
type RemoteDevice = { id: string; kind?: 'node' | 'printer'; aeTitle: string; callingAeTitle?: string; ip: string; port: number; description?: string; enabled?: boolean };
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
};
type PrintPreviewImage = DicomImage & { instanceId: string };

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

function dicomPrintFooterLines(study?: Study) {
  if (!study) return [];
  const line1 = `PACIENTE: ${patientName(study.patientName) || '-'}   ID: ${study.patientId || '-'}   SEXO: ${study.patientSex || '-'}   NASC: ${formatDicomDate(study.patientBirthDate)}`;
  const line2 = `ESTUDO: ${study.studyDescription || '-'}   MOD: ${study.modality || '-'}   DATA: ${formatDicomDate(study.studyDate)} ${formatDicomTime(study.studyTime)}${study.institution ? `   INST: ${study.institution}` : ''}`;
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

function imageFromServerPixels(payload: ServerPixelPayload): DicomImage {
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
  };
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
  image, viewport, annotations, activeTool, onViewportChange, onAnnotate, onDropImage, onClick, onMoveAnnotation, onDeleteAnnotation,
}: {
  image?: DicomImage;
  viewport: ViewportState;
  annotations: PrintAnnotation[];
  activeTool: PrintTool;
  onViewportChange: (viewport: ViewportState) => void;
  onAnnotate: (x: number, y: number, label: string) => void;
  onDropImage: (idx: number) => void;
  onClick: () => void;
  onMoveAnnotation?: (id: string, x: number, y: number) => void;
  onDeleteAnnotation?: (id: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number; viewport: ViewportState } | null>(null);
  const annotationDragId = useRef<string | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

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
      if (image) renderImage(ctx, image, viewport, rect.width, rect.height);
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
  }, [image, viewport]);

  return <>
    <canvas
      ref={ref}
      className="h-full w-full"
      onClick={(event) => {
        onClick();
        if (!image || (activeTool !== 'markD' && activeTool !== 'markE' && activeTool !== 'text')) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const point = screenToImage(event.clientX - rect.left, event.clientY - rect.top, viewport, rect.width, rect.height, image.width, image.height);
        const label = activeTool === 'text' ? window.prompt('Texto livre', '') : activeTool === 'markD' ? 'D' : 'E';
        if (label?.trim()) onAnnotate(point.x, point.y, label.trim());
      }}
      onMouseDown={(event) => {
        onClick();
        dragRef.current = { x: event.clientX, y: event.clientY, viewport: { ...viewport } };
      }}
      onMouseMove={(event) => {
        if (!image || !dragRef.current || event.buttons !== 1) return;
        const dx = event.clientX - dragRef.current.x;
        const dy = event.clientY - dragRef.current.y;
        if (activeTool === 'zoom') onViewportChange({ ...dragRef.current.viewport, zoom: Math.max(0.05, dragRef.current.viewport.zoom * (1 + dy * 0.005)) });
        else if (activeTool === 'pan') onViewportChange({ ...dragRef.current.viewport, panX: dragRef.current.viewport.panX + dx, panY: dragRef.current.viewport.panY + dy });
        else if (activeTool === 'wl') onViewportChange({ ...dragRef.current.viewport, windowWidth: Math.max(1, dragRef.current.viewport.windowWidth + dx * 8), windowCenter: dragRef.current.viewport.windowCenter - dy * 8 });
      }}
      onMouseUp={() => { dragRef.current = null; }}
      onMouseLeave={() => { dragRef.current = null; }}
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
    {image && canvasSize.width > 0 && annotations.map((annotation) => {
      const point = imageToScreenPoint(annotation.x, annotation.y, viewport, canvasSize.width, canvasSize.height, image.width, image.height);
      return (
        <div
          key={annotation.id}
          className="pacs-annotation group absolute flex items-center gap-1 rounded px-1.5 py-0.5 text-[13px] font-bold text-slate-950"
          style={{ left: point.x, top: point.y, transform: 'translate(-50%, -50%)', background: 'rgba(34, 211, 238, 0.9)', cursor: onMoveAnnotation ? 'grab' : 'default', touchAction: 'none', userSelect: 'none' }}
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
            const next = screenToImage(event.clientX - rect.left, event.clientY - rect.top, viewport, rect.width, rect.height, image.width, image.height);
            onMoveAnnotation(annotation.id, next.x, next.y);
          }}
          onPointerUp={(event) => {
            annotationDragId.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
        >
          {annotation.label}
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
  const [scope, setScope] = useState<'all' | 'selected'>(requestedIds.length ? 'selected' : 'all');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewImages, setPreviewImages] = useState<PrintPreviewImage[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [activeTool, setActiveTool] = useState<PrintTool>('wl');
  const [activeCell, setActiveCell] = useState(0);
  const [cellImageIdxs, setCellImageIdxs] = useState<number[]>(Array(9).fill(0));
  const [cellViewports, setCellViewports] = useState<Array<ViewportState | null>>(Array(9).fill(null));
  const [annotations, setAnnotations] = useState<PrintAnnotation[]>([]);
  const [printerConfigOpen, setPrinterConfigOpen] = useState(false);
  const [printerDrafts, setPrinterDrafts] = useState<RemoteDevice[]>([]);
  const [printerSaving, setPrinterSaving] = useState(false);
  const [pendingPrinterId, setPendingPrinterId] = useState('');
  const [printJobs, setPrintJobs] = useState<PrintJob[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueStatus, setQueueStatus] = useState('');

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

  useEffect(() => {
    setActiveCell((cell) => Math.min(cell, Math.max(0, cellCount - 1)));
  }, [cellCount]);

  useEffect(() => {
    let cancelled = false;
    const study = targetStudies[0];
    if (!study) { setPreviewImages([]); return; }
    setPreviewLoading(true);
    apiFetch(`/api/studies/${study.id}/viewer-data`)
      .then(async (response) => response.ok ? response.json() : { instances: [], initialPixels: {} })
      .then(async (payload) => {
        const instances = (payload.instances ?? []).slice(0, Math.max(cellCount, 24)) as Array<{ id: number | string }>;
        const initial = payload.initialPixels ?? {};
        const images: PrintPreviewImage[] = new Array(instances.length);
        const loadOne = async (instance: { id: number | string }, index: number) => {
          const id = String(instance.id);
          const pixelPayload = initial[id] ?? await apiFetch(`/api/instances/${id}/pixels`).then((response) => response.ok ? response.json() : null);
          if (pixelPayload) images[index] = { ...imageFromServerPixels(pixelPayload), instanceId: id };
        };

        const BATCH_SIZE = 6;
        for (let start = 0; start < instances.length; start += BATCH_SIZE) {
          const batch = instances.slice(start, start + BATCH_SIZE);
          await Promise.all(batch.map((instance, offset) => loadOne(instance, start + offset).catch(() => undefined)));
          if (!cancelled) setPreviewImages(images.filter(Boolean));
        }
      })
      .catch(() => { if (!cancelled) setPreviewImages([]); })
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
  const activeViewport = cellViewports[activeCell] ?? (activeImage ? viewportFromImage(activeImage) : fallbackViewport);

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
  };

  const moveAnnotation = (id: string, x: number, y: number) => {
    setAnnotations((current) => current.map((annotation) => annotation.id === id ? { ...annotation, x, y } : annotation));
  };

  const deleteAnnotation = (id: string) => {
    setAnnotations((current) => current.filter((annotation) => annotation.id !== id));
  };

  const submit = async () => {
    if (!targetStudies.length) { setStatus('Nenhum estudo disponivel para impressao.'); return; }
    if (printerKind === 'dicom' && !deviceId) { setStatus('Selecione uma impressora DICOM ativa.'); return; }
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
          footerLines: dicomPrintFooterLines(study),
          cells: Array.from({ length: cellCount }).map((_, cell) => {
            const image = previewImages[cellImageIdxs[cell]];
            const viewport = cellViewports[cell] ?? (image ? viewportFromImage(image) : null);
            const cellAnnotations = annotations.filter((annotation) => annotation.cell === cell).map(({ x, y, label }) => ({ x, y, label }));
            return image && viewport ? { cell, instanceId: image.instanceId, viewport, annotations: cellAnnotations } : null;
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
          body: JSON.stringify({ deviceId, layout, copies, orientation, filmSize, printState }),
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
          {previewLoading && <Loader2 className="animate-spin text-cyan-300" size={18} />}
        </header>

        <div className="pacs-print-ui flex border-b border-white/10 bg-[#0c1520] px-2">
          {[
            { id: 'wl', label: 'Brilho', icon: <Contrast size={15} /> },
            { id: 'invert', label: 'Negativo', icon: <Moon size={15} /> },
            { id: 'zoom', label: 'Zoom', icon: <ZoomIn size={15} /> },
            { id: 'pan', label: 'Mover', icon: <Move size={15} /> },
            { id: 'rotate', label: 'Girar', icon: <RotateCw size={15} /> },
            { id: 'markD', label: 'D', icon: <span className="text-sm font-black">D</span> },
            { id: 'markE', label: 'E', icon: <span className="text-sm font-black">E</span> },
            { id: 'text', label: 'Texto', icon: <Type size={15} /> },
            { id: 'fit', label: 'Ajustar', icon: <Maximize2 size={15} /> },
          ].map((tool) => (
            <button
              key={tool.id}
              onClick={() => {
                if (tool.id === 'rotate') setCellViewport(activeCell, { ...activeViewport, rotation: ((activeViewport.rotation + 90) % 360) as ViewportState['rotation'] });
                else if (tool.id === 'invert') setCellViewport(activeCell, { ...activeViewport, invert: !activeViewport.invert });
                else if (tool.id === 'fit' && previewImages[cellImageIdxs[activeCell]]) setCellViewport(activeCell, viewportFromImage(previewImages[cellImageIdxs[activeCell]]));
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

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="pacs-print-stage flex flex-1 items-center justify-center p-5">
          <div className={`pacs-print-sheet ${orientation === 'portrait' ? 'pacs-print-portrait aspect-[10/13] h-full max-h-[calc(100vh-150px)]' : 'pacs-print-landscape aspect-[13/10] w-full max-w-[calc(100vw-640px)]'} flex flex-col rounded border border-slate-500 bg-black p-2 shadow-inner`}>
            <div className="grid min-h-0 flex-1 gap-2" style={{ gridTemplateColumns: `repeat(${activeLayout.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${activeLayout.rows}, minmax(0, 1fr))` }}>
              {Array.from({ length: cellCount }).map((_, index) => <div key={index} className="relative overflow-hidden rounded-sm border border-slate-700 bg-black">
                {previewImages[cellImageIdxs[index]] ? <PreviewCanvas
                  image={previewImages[cellImageIdxs[index]]}
                  viewport={cellViewports[index] ?? viewportFromImage(previewImages[cellImageIdxs[index]])}
                  annotations={annotations.filter((annotation) => annotation.cell === index)}
                  activeTool={activeTool}
                  onViewportChange={(nextViewport) => setCellViewport(index, nextViewport)}
                  onClick={() => setActiveCell(index)}
                  onDropImage={(idx) => setCellImage(index, idx)}
                  onAnnotate={(x, y, label) => setAnnotations((current) => [...current, { id: `${Date.now()}_${Math.random()}`, cell: index, x, y, label }])}
                  onMoveAnnotation={moveAnnotation}
                  onDeleteAnnotation={deleteAnnotation}
                /> : <div className="grid h-full place-items-center text-slate-600"><ImageIcon size={24} /></div>}
                <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[9px] text-cyan-200">{index + 1}</span>
              </div>)}
            </div>
            <div className="mt-2 flex-shrink-0 border-t border-slate-700/80 bg-black pt-2 font-mono text-[10px] font-semibold uppercase leading-snug text-slate-100">
              {dicomPrintFooterLines(firstStudy).map((line, index) => (
                <div key={index} className="truncate">
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
                    <option style={{ backgroundColor: '#263645', color: '#fff' }}>14INX17IN</option><option style={{ backgroundColor: '#263645', color: '#fff' }}>11INX14IN</option><option style={{ backgroundColor: '#263645', color: '#fff' }}>10INX12IN</option><option style={{ backgroundColor: '#263645', color: '#fff' }}>8INX10IN</option>
                  </select>
                </label>
              )}
            </div>

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
