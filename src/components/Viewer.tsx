import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Layers, ImageIcon, RefreshCw, Columns2, Contrast, Hand, Search,
  Maximize2, Moon, RotateCcw, Wrench, MoreHorizontal, MessageSquare,
  Play, FileText, Bookmark, GripVertical, User, Check, Ruler, Triangle,
  Grid2x2, Grid3x3, Square, LayoutTemplate, ChevronDown,
  ArrowLeft, PanelRight, Save, CheckCircle2, MonitorUp, ChevronsDown,
  Type, RotateCw, ZoomIn, X,
} from 'lucide-react';
import type { DicomImage, Measurement, Series, Study } from '@/types';
import { apiFetch, sessionFragment } from '@/lib/apiClient';
import { parseDicomImage } from '@/lib/dicomFile';
import {
  type ViewportState, viewportFromImage, renderImage, screenToImage, imageToScreen,
  renderMeasurements, computeAngle, computeLength, defaultViewport,
} from '@/lib/dicomViewer';

interface ViewerProps {
  study: Study;
  allSeries: Series[];
}

type Layout = 'single' | '1x2' | '2x2' | '3x3';
type ActiveTool = 'wl' | 'pan' | 'zoom' | 'scroll' | 'length' | 'angle' | 'cine' | 'markD' | 'markE' | 'text';
const WINDOW_LEVEL_DRAG_SENSITIVITY = 8;

interface ServerPixelPayload {
  width: number;
  height: number;
  bitsAllocated: number;
  pixelRepresentation: number;
  photometricInterpretation: string;
  samplesPerPixel: number;
  windowCenter: number;
  windowWidth: number;
  pixelSpacing: number;
  sliceThickness: number;
  instanceNumber: number;
  sliceLocation: number;
  pixelDataBase64: string;
}

const dicomImageCache = new Map<string, Promise<DicomImage>>();
const stackThumbCache = new Map<string, string>();
type StackInstance = { id: string; series_id?: string; instance_number: number; series_number: number };

function primeDicomImageCache(instanceId: string, payload: ServerPixelPayload) {
  dicomImageCache.set(instanceId, Promise.resolve(imageFromServerPixels(payload)));
}

function formatPatientName(raw: string): string {
  return raw.split('^').filter(Boolean).join(' ');
}

function calcAge(birthDate: string): string {
  if (!birthDate) return '';
  const birth = new Date(birthDate);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  if (now < new Date(now.getFullYear(), birth.getMonth(), birth.getDate())) age--;
  return String(age).padStart(3, '0') + 'Y';
}

function fmtBirth(d: string) {
  if (!d) return '';
  const [y, m, dd] = d.split('-');
  return `${y}/${m}/${dd}`;
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
  const pixelCount = width * height;
  const pixelData = new Float32Array(pixelCount);

  for (let i = 0; i < pixelCount; i++) {
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

async function loadDicomImage(instanceId: string): Promise<DicomImage> {
  const cached = dicomImageCache.get(instanceId);
  if (cached) return cached;

  const request = (async () => {
  const pixelResponse = await apiFetch(`/api/instances/${instanceId}/pixels`);
  if (pixelResponse.ok) return imageFromServerPixels(await pixelResponse.json() as ServerPixelPayload);

  let fileError: unknown = null;
  const fileResponse = await apiFetch(`/api/instances/${instanceId}/file`);
  if (fileResponse.ok) {
    try {
      return parseDicomImage(await fileResponse.arrayBuffer());
    } catch (error) {
      fileError = error;
    }
  }

  const result = await fileResponse.json().catch(() => ({}));
  throw new Error(result.error ?? (fileError instanceof Error ? fileError.message : 'Falha ao ler arquivo DICOM.'));
  })();

  dicomImageCache.set(instanceId, request);
  request.catch(() => dicomImageCache.delete(instanceId));
  return request;
}

//  DicomCanvas 

interface DicomCanvasProps {
  image: DicomImage | null;
  imageStack: DicomImage[];
  currentIdx: number;
  viewport: ViewportState;
  measurements: Measurement[];
  activeMeasureId: string | null;
  activeTool: ActiveTool;
  onViewportChange: (vp: ViewportState) => void;
  onCurrentIdxChange: (idx: number) => void;
  onAddMeasurement: (m: Measurement) => void;
  onUpdateMeasurement: (m: Measurement) => void;
  onSetActiveMeasurement: (id: string | null) => void;
  onDeleteMeasurement: (id: string) => void;
  onMeasureComplete: () => void;
  onDropImageIndex?: (idx: number) => void;
  onClick?: () => void;
  isActive: boolean;
  showOverlays: boolean;
  studyInfo: {
    patientName: string; patientId: string; birthDate: string;
    sex: string; studyDescription: string; modality: string; studyDate: string; studyTime: string;
  };
  seriesInfo: { description: string; number: number };
}

function DicomCanvas({
  image, imageStack, currentIdx, viewport, measurements, activeMeasureId, activeTool,
  onViewportChange, onCurrentIdxChange, onAddMeasurement, onUpdateMeasurement,
  onSetActiveMeasurement, onDeleteMeasurement, onMeasureComplete, onDropImageIndex, onClick, isActive, showOverlays, studyInfo,
}: DicomCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; vp: ViewportState; idx: number } | null>(null);
  const measureRef = useRef<Measurement | null>(null);
  const isDraggingRef = useRef(false);
  const touchRef = useRef<{ x: number; y: number; distance: number; vp: ViewportState; idx: number } | null>(null);
  const annotationDragId = useRef<string | null>(null);
  const [size, setSize] = useState({ w: 512, h: 512 });
  const [displayZoomPct, setDisplayZoomPct] = useState(100);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.max(64, r.width), h: Math.max(64, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (image) {
      renderImage(ctx, image, viewport, size.w, size.h);
      // Marker/text annotations are rendered as draggable DOM overlays below,
      // not baked into the canvas raster - only line-based measurements go here.
      renderMeasurements(ctx, measurements.filter((m) => m.type === 'length' || m.type === 'angle'), viewport, size.w, size.h, image.width, image.height, image.pixelSpacing, activeMeasureId);
      const baseScale = Math.min(size.w / image.width, size.h / image.height);
      setDisplayZoomPct(baseScale * viewport.zoom * 100);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, size.w, size.h);
    }
  }, [image, viewport, measurements, activeMeasureId, size]);

  const getPos = (e: React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    onClick?.();
    if (!image) return;
    onSetActiveMeasurement(null);
    const pos = getPos(e);

    if ((activeTool === 'markD' || activeTool === 'markE' || activeTool === 'text') && e.button === 0) {
      const imgPt = screenToImage(pos.x, pos.y, viewport, size.w, size.h, image.width, image.height);
      const label = activeTool === 'text' ? window.prompt('Texto livre', '') : activeTool === 'markD' ? 'D' : 'E';
      if (label !== null && label.trim()) {
        const id = `a${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        onAddMeasurement({ id, type: activeTool === 'text' ? 'text' : 'marker', points: [imgPt], value: null, label: label.trim() });
      }
      return;
    }

    if ((activeTool === 'length' || activeTool === 'angle') && e.button === 0) {
      const imgPt = screenToImage(pos.x, pos.y, viewport, size.w, size.h, image.width, image.height);
      const id = `m${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const m: Measurement = { id, type: activeTool, points: [imgPt], value: null, label: '' };
      measureRef.current = m;
      onAddMeasurement(m);
      isDraggingRef.current = true;
      return;
    }

    const isPan = activeTool === 'pan' || e.button === 2 || e.button === 1 || (e.button === 0 && e.shiftKey);
    dragRef.current = { x: pos.x, y: pos.y, vp: { ...viewport }, idx: currentIdx };
    isDraggingRef.current = true;
    if (!isPan) e.preventDefault();
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDraggingRef.current || !image) return;
    const pos = getPos(e);
    const start = dragRef.current;

    if (measureRef.current && (activeTool === 'length' || activeTool === 'angle')) {
      const imgPt = screenToImage(pos.x, pos.y, viewport, size.w, size.h, image.width, image.height);
      const m = measureRef.current;
      let updated: Measurement;
      if (m.type === 'length') {
        updated = { ...m, points: [m.points[0], imgPt], value: computeLength(m.points[0], imgPt, image.pixelSpacing) };
      } else {
        const pts = m.points.length < 2 ? [...m.points, imgPt] : [m.points[0], m.points[1], imgPt];
        updated = { ...m, points: pts, value: pts.length === 3 ? computeAngle(pts[0], pts[1], pts[2]) : null };
      }
      measureRef.current = updated;
      onUpdateMeasurement(updated);
      return;
    }

    if (!start) return;
    const dx = pos.x - start.x;
    const dy = pos.y - start.y;

    if (activeTool === 'pan' || e.buttons === 2 || e.buttons === 4) {
      onViewportChange({ ...start.vp, panX: start.vp.panX + dx, panY: start.vp.panY + dy });
    } else if (activeTool === 'zoom') {
      const factor = 1 + dy * 0.005;
      onViewportChange({ ...start.vp, zoom: Math.max(0.05, start.vp.zoom * factor) });
    } else if (activeTool === 'scroll') {
      const nextIdx = start.idx + Math.trunc(dy / 24);
      onCurrentIdxChange(Math.max(0, Math.min(imageStack.length - 1, nextIdx)));
    } else if (activeTool === 'wl') {
      onViewportChange({
        ...start.vp,
        windowWidth: Math.max(1, start.vp.windowWidth + dx * WINDOW_LEVEL_DRAG_SENSITIVITY),
        windowCenter: start.vp.windowCenter - dy * WINDOW_LEVEL_DRAG_SENSITIVITY,
      });
    }
  };

  const handleMouseUp = () => {
    if (measureRef.current) {
      const m = measureRef.current;
      if ((m.type === 'length' && m.points.length >= 2) || (m.type === 'angle' && m.points.length >= 3)) {
        onMeasureComplete();
      }
    }
    isDraggingRef.current = false;
    dragRef.current = null;
    measureRef.current = null;
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!image) return;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    onViewportChange({ ...viewport, zoom: Math.max(0.05, viewport.zoom * delta) });
  };

  const touchDistance = (touches: React.TouchList) => touches.length < 2 ? 0 : Math.hypot(touches[1].clientX - touches[0].clientX, touches[1].clientY - touches[0].clientY);
  const handleTouchStart = (e: React.TouchEvent) => {
    onClick?.();
    const touch = e.touches[0];
    touchRef.current = { x: touch.clientX, y: touch.clientY, distance: touchDistance(e.touches), vp: { ...viewport }, idx: currentIdx };
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    const start = touchRef.current;
    if (!start) return;
    e.preventDefault();
    if (e.touches.length >= 2 && start.distance > 0) {
      onViewportChange({ ...start.vp, zoom: Math.max(0.05, start.vp.zoom * touchDistance(e.touches) / start.distance) });
      return;
    }
    const dx = e.touches[0].clientX - start.x;
    const dy = e.touches[0].clientY - start.y;
    if (activeTool === 'pan') onViewportChange({ ...start.vp, panX: start.vp.panX + dx, panY: start.vp.panY + dy });
    else if (activeTool === 'zoom') onViewportChange({ ...start.vp, zoom: Math.max(0.05, start.vp.zoom * (1 + dy * .005)) });
    else if (activeTool === 'wl') {
      onViewportChange({
        ...start.vp,
        windowWidth: Math.max(1, start.vp.windowWidth + dx * WINDOW_LEVEL_DRAG_SENSITIVITY),
        windowCenter: start.vp.windowCenter - dy * WINDOW_LEVEL_DRAG_SENSITIVITY,
      });
    }
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    const start = touchRef.current;
    if (start && activeTool === 'scroll' && e.changedTouches[0]) {
      const dy = e.changedTouches[0].clientY - start.y;
      if (Math.abs(dy) > 28) onCurrentIdxChange(Math.max(0, Math.min(imageStack.length - 1, start.idx + (dy < 0 ? 1 : -1))));
    }
    touchRef.current = null;
  };

  const cursor = activeTool === 'pan' ? 'grab' : activeTool === 'zoom' ? 'zoom-in' : activeTool === 'length' || activeTool === 'angle' || activeTool === 'markD' || activeTool === 'markE' || activeTool === 'text' ? 'crosshair' : activeTool === 'scroll' ? 'ns-resize' : 'default';

  const scrollPct = imageStack.length > 1 ? currentIdx / (imageStack.length - 1) : 0;

  return (
    <div
      ref={containerRef}
      className="pacs-dicom-canvas relative h-full w-full touch-none overflow-hidden bg-black"
      style={{ border: isActive ? '1px solid #3b82f6' : '1px solid #1e293b', boxShadow: isActive ? 'inset 0 0 0 1px rgba(59,130,246,.2)' : undefined }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const idx = Number(event.dataTransfer.getData('application/x-pacs-image-index'));
        if (Number.isFinite(idx)) onDropImageIndex?.(idx);
      }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ cursor }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* Patient info  top left */}
      {image && showOverlays && (
        <div className="pointer-events-none absolute left-2 top-1 font-mono text-[11px] leading-[1.35] text-white drop-shadow-[0_0_3px_rgba(0,0,0,1)]">
          <div>{studyInfo.patientId.replace('PT-', '')}</div>
          <div>{studyInfo.patientName}</div>
          <div>{fmtBirth(studyInfo.birthDate)}</div>
          <div>{calcAge(studyInfo.birthDate)}</div>
          <div>{studyInfo.sex}</div>
        </div>
      )}

      {/* Study date/time  top right */}
      {image && showOverlays && (
        <div className="pointer-events-none absolute right-2 top-1 text-right font-mono text-[11px] leading-[1.35] text-white drop-shadow-[0_0_3px_rgba(0,0,0,1)]">
          <div>{studyInfo.studyDate.replace(/-/g, '/')} {studyInfo.studyTime}</div>
          <div>--</div>
          <div>--</div>
          <div>--</div>
        </div>
      )}

      {/* Slice number  bottom left */}
      {image && showOverlays && (
        <div className="pointer-events-none absolute left-2 bottom-1 font-mono text-[11px] text-white drop-shadow-[0_0_3px_rgba(0,0,0,1)]">
          {currentIdx + 1} ({currentIdx + 1}/{imageStack.length})
        </div>
      )}

      {/* W/L + zoom  bottom right */}
      {image && showOverlays && (
        <div className="pointer-events-none absolute right-4 bottom-1 text-right font-mono text-[11px] leading-[1.35] text-white drop-shadow-[0_0_3px_rgba(0,0,0,1)]">
          <div>{displayZoomPct.toFixed(2)}%</div>
          <div>T: --</div>
          <div>L: --</div>
          <div>WW: {Math.round(viewport.windowWidth)} WC: {Math.round(viewport.windowCenter)}</div>
        </div>
      )}

      {/* Orange scroll position indicator  right edge */}
      {imageStack.length > 1 && showOverlays && (
        <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-2 flex flex-col justify-start">
          <div
            className="w-1.5 ml-0.5 rounded-sm bg-orange-400 opacity-80"
            style={{
              position: 'absolute',
              height: '16%',
              top: `${scrollPct * 84}%`,
            }}
          />
        </div>
      )}

      {/* D/E/Text markers - draggable and deletable DOM overlays */}
      {image && measurements.filter((m) => m.type === 'marker' || m.type === 'text').map((m) => {
        const point = imageToScreen(m.points[0].x, m.points[0].y, viewport, size.w, size.h, image.width, image.height);
        const isActive = m.id === activeMeasureId;
        return (
          <div
            key={m.id}
            className="pacs-annotation group absolute flex items-center gap-1 rounded px-1.5 py-0.5 text-[13px] font-bold text-slate-950"
            style={{
              left: point.x, top: point.y, transform: 'translate(-50%, -50%)',
              background: isActive ? 'rgba(251, 191, 36, 0.9)' : 'rgba(34, 211, 238, 0.85)',
              cursor: 'grab', touchAction: 'none', userSelect: 'none',
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.preventDefault();
              onSetActiveMeasurement(m.id);
              annotationDragId.current = m.id;
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (annotationDragId.current !== m.id) return;
              const rect = canvasRef.current?.getBoundingClientRect();
              if (!rect) return;
              const next = screenToImage(event.clientX - rect.left, event.clientY - rect.top, viewport, size.w, size.h, image.width, image.height);
              onUpdateMeasurement({ ...m, points: [next] });
            }}
            onPointerUp={(event) => {
              annotationDragId.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
          >
            {m.label || (m.type === 'marker' ? 'D' : 'Texto')}
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); onDeleteMeasurement(m.id); }}
              onPointerDown={(event) => event.stopPropagation()}
              className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-950/70 text-cyan-100 opacity-0 transition-opacity group-hover:opacity-100"
              title="Remover anotacao"
            >
              <X size={9} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

//  Series thumbnail 

function useVisibleThumb<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || visible) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '240px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  return { ref, visible };
}

function StackThumb({ instance, index, active, onClick }: { instance: StackInstance; index: number; active: boolean; onClick: () => void }) {
  const { ref, visible } = useVisibleThumb<HTMLButtonElement>();
  const [thumb, setThumb] = useState('');

  useEffect(() => {
    if (!visible && !active) return;
    const cached = stackThumbCache.get(instance.id);
    if (cached) { setThumb(cached); return; }

    let cancelled = false;
    const run = async () => {
      if (cancelled) return;
      const response = await apiFetch(`/api/instances/${instance.id}/thumbnail`);
      if (!response.ok) return;
      const payload = await response.json() as ServerPixelPayload;
      const image = imageFromServerPixels(payload);
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 92;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      renderImage(ctx, image, viewportFromImage(image), 120, 92);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
      stackThumbCache.set(instance.id, dataUrl);
      if (!cancelled) setThumb(dataUrl);
    };
    const idleId = 'requestIdleCallback' in globalThis
      ? globalThis.requestIdleCallback(run, { timeout: 900 })
      : globalThis.setTimeout(run, 16);
    return () => {
      cancelled = true;
      if ('cancelIdleCallback' in globalThis && typeof idleId === 'number') globalThis.cancelIdleCallback(idleId);
      else if (typeof idleId === 'number') globalThis.clearTimeout(idleId);
    };
  }, [instance.id, visible, active]);

  return (
    <button
      ref={ref}
      draggable
      onDragStart={(event) => event.dataTransfer.setData('application/x-pacs-image-index', String(index))}
      onClick={onClick}
      className={`relative h-[104px] w-full overflow-hidden rounded border bg-black text-left transition ${active ? 'border-cyan-300 shadow-[0_0_0_1px_rgba(34,211,238,.35)]' : 'border-slate-700 hover:border-slate-400'}`}
      title={`Imagem ${index + 1}`}
    >
      {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full w-full place-items-center bg-slate-950 text-[10px] text-slate-600">{index + 1}</div>}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/70 px-2 py-1 text-[10px] font-semibold text-slate-100">
        <span>{index + 1}</span>
        <span>{instance.instance_number || index + 1}</span>
      </div>
    </button>
  );
}

//  Toolbar button 

function ToolBtn({
  icon, label, active, onClick,
}: {
  icon: React.ReactNode; label: string; active?: boolean; onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`relative my-1 flex min-w-[54px] flex-col items-center gap-1 rounded-md px-2 py-1.5 text-[9px] font-medium transition-all select-none ${
        active
          ? 'bg-blue-600/15 text-blue-200'
          : 'text-blue-100/70 hover:bg-white/10 hover:text-white'
      }`}
    >
      <span className={active ? 'text-blue-300' : ''}>{icon}</span>
      <span className="whitespace-nowrap leading-none">{label}</span>
      {active && (
        <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-sm bg-cyan-400" />
      )}
    </button>
  );
}

function Divider() {
  return <div className="mx-1 my-2 h-7 w-px flex-shrink-0 bg-blue-300/20" />;
}

//  Main Viewer 

export function Viewer({ study, allSeries }: ViewerProps) {
  const isCompanionScreen = new URLSearchParams(window.location.search).get('companion') === '1';
  const [loadedSeries, setLoadedSeries] = useState<Series[]>([]);
  const [loadedInstances, setLoadedInstances] = useState<Array<{ id: string; series_id: string; instance_number: number; series_number: number }>>([]);
  const [viewerDataLoaded, setViewerDataLoaded] = useState(false);
  const studySeries = useMemo(() => {
    const source = loadedSeries.length ? loadedSeries : allSeries;
    return source.filter((s) => s.studyId === study.id).sort((a, b) => a.seriesNumber - b.seriesNumber);
  }, [allSeries, loadedSeries, study.id]);

  useEffect(() => {
    let cancelled = false;
    setLoadedSeries([]);
    setLoadedInstances([]);
    setViewerDataLoaded(false);
    apiFetch(`/api/studies/${study.id}/viewer-data`)
      .then(async (response) => response.ok ? await response.json() as { series?: Array<Record<string, unknown>>; instances?: Array<Record<string, unknown>>; initialPixels?: Record<string, ServerPixelPayload> } : { series: [], instances: [], initialPixels: {} })
      .then((payload) => {
        if (cancelled) return;
        Object.entries(payload.initialPixels ?? {}).forEach(([instanceId, pixelPayload]) => primeDicomImageCache(instanceId, pixelPayload));
        setLoadedSeries((payload.series ?? []).map((row): Series => ({
          id: String(row.id),
          studyId: String(row.study_id ?? study.id),
          seriesNumber: Number(row.series_number ?? 0),
          modality: String(row.modality ?? ''),
          seriesDescription: String(row.series_description ?? ''),
          bodyPartExamined: String(row.body_part_examined ?? ''),
          imageCount: Number(row.image_count ?? 0),
        })));
        setLoadedInstances((payload.instances ?? []).map((row) => ({
          id: String(row.id),
          series_id: String(row.series_id),
          instance_number: Number(row.instance_number ?? 0),
          series_number: Number(row.series_number ?? 0),
        })));
        setViewerDataLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setViewerDataLoaded(true);
      });
    return () => { cancelled = true; };
  }, [study.id]);

  const [activeSeriesIdx, setActiveSeriesIdx] = useState(0);
  const activeSeries = studySeries[activeSeriesIdx] ?? studySeries[0];
  const activeSeriesId = activeSeries?.id ?? '';
  // Sempre carrega todas as series do exame num unico stack continuo,
  // em vez de restringir a imagem exibida a apenas a serie selecionada.
  const stackSeries = studySeries;
  const stackSeriesKey = stackSeries.map((series) => `${series.id}:${series.imageCount}`).join('|');

  const [imageStack, setImageStack] = useState<DicomImage[]>([]);
  const [stackInstances, setStackInstances] = useState<StackInstance[]>([]);
  const [imageLoadError, setImageLoadError] = useState<string | null>(null);
  const [isImageStackLoading, setIsImageStackLoading] = useState(false);

  useEffect(() => {
    setActiveSeriesIdx((idx) => Math.min(idx, Math.max(0, studySeries.length - 1)));
  }, [studySeries.length]);

  useEffect(() => {
    if (!stackSeries.length || !viewerDataLoaded) {
      setImageStack([]);
      setStackInstances([]);
      return;
    }
    let cancelled = false;
    setImageStack([]);
    setImageLoadError(null);
    setIsImageStackLoading(true);
    const stackSeriesIds = new Set(stackSeries.map((series) => series.id));
    const readyInstances = loadedInstances.filter((instance) => stackSeriesIds.has(String(instance.series_id)));
    const instancesPromise = readyInstances.length
      ? Promise.resolve(stackSeries.map((series) => readyInstances
          .filter((instance) => String(instance.series_id) === series.id)
          .map((instance) => ({ ...instance, series_number: series.seriesNumber }))))
      : Promise.all(stackSeries.map(async (series) => {
          const response = await apiFetch(`/api/series/${series.id}/instances`);
          if (!response.ok) throw new Error('Nao foi possivel carregar as instancias DICOM.');
          const instances = await response.json() as Array<{ id: string; instance_number: number }>;
          return instances.map((instance) => ({ ...instance, series_id: series.id, series_number: series.seriesNumber }));
        }));
    instancesPromise
      .then(async (instances) => {
        const ordered = instances.flat().sort((a, b) => {
          const bySeries = Number(a.series_number ?? 0) - Number(b.series_number ?? 0);
          return bySeries || Number(a.instance_number ?? 0) - Number(b.instance_number ?? 0);
        });
        // Fetch instances in parallel batches instead of one at a time.
        // Sequentially awaiting each request (the old code) meant total load
        // time was (round trip + decrypt) x number of images  with ~24
        // images that alone accounts for the ~15s delay reported opening a
        // study. Small concurrent batches keep server load bounded while
        // still loading many times faster; each batch is pushed into the
        // stack as soon as it's ready so the first images still appear fast.
        if (!ordered.length) {
          if (!cancelled) setImageStack([]);
          if (!cancelled) setStackInstances([]);
          return;
        }

        const images: DicomImage[] = new Array(ordered.length);
        if (!cancelled) setStackInstances(ordered.map((instance) => ({
          id: String(instance.id),
          series_id: String(instance.series_id ?? ''),
          instance_number: Number(instance.instance_number ?? 0),
          series_number: Number(instance.series_number ?? 0),
        })));
        const firstImage = await loadDicomImage(ordered[0].id);
        images[0] = firstImage;
        if (!cancelled) setImageStack(images);
      })
      .catch((error) => {
        if (!cancelled) setImageLoadError(error instanceof Error ? error.message : 'Falha ao carregar imagens DICOM.');
      })
      .finally(() => {
        if (!cancelled) setIsImageStackLoading(false);
      });
    return () => { cancelled = true; };
  }, [stackSeriesKey, loadedInstances, viewerDataLoaded]);

  const [cellViewports, setCellViewports] = useState<Array<ViewportState | null>>(Array(9).fill(null));
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [activeMeasureId, setActiveMeasureId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<ActiveTool>('wl');
  const [layout, setLayout] = useState<Layout>('single');
  const [activeCell, setActiveCell] = useState(0);
  const [seriesPanelOpen, setSeriesPanelOpen] = useState(!isCompanionScreen);
  const [companionToolsExpanded, setCompanionToolsExpanded] = useState(false);
  const [showOverlays, setShowOverlays] = useState(true);
  const [syncScroll, setSyncScroll] = useState(false);
  const [comparisonMode, setComparisonMode] = useState(false);
  const [annotationText, setAnnotationText] = useState('');
  const [keyImages, setKeyImages] = useState<Set<number>>(new Set());
  const [reportPanelOpen, setReportPanelOpen] = useState(false);
  const [reportText, setReportText] = useState('ACHADOS:\n\n\nCONCLUSÒO:\n');
  const [reportStatus, setReportStatus] = useState<'pending' | 'draft' | 'signed'>('pending');
  useEffect(() => { apiFetch(`/api/reports/study/${study.id}`).then((response) => response.ok ? response.json() : null).then((report) => { if (report) { setReportText(report.content ?? ''); setReportStatus(report.status); } }).catch(() => undefined); }, [study.id]);
  const saveViewerReport = async (status: 'draft' | 'signed') => {
    const response = await apiFetch(`/api/reports/study/${study.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: reportText, status }) });
    if (response.ok) setReportStatus(status);
    else { const result = await response.json().catch(() => ({})); window.alert(result.error ?? 'Não foi possível salvar o laudo.'); }
  };

  // Per-panel slice index
  const cellCount = layout === 'single' ? 1 : layout === '1x2' ? 2 : layout === '2x2' ? 4 : 9;
  const [cellIdxs, setCellIdxs] = useState<number[]>([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const setCellIdx = useCallback((cell: number, idx: number) => {
    setCellIdxs((prev) => { const next = [...prev]; next[cell] = idx; return next; });
  }, []);
  const setCellViewport = useCallback((cell: number, nextViewport: ViewportState) => {
    setCellViewports((prev) => { const next = [...prev]; next[cell] = nextViewport; return next; });
  }, []);

  useEffect(() => {
    if (!stackSeriesKey) return;
    setMeasurements([]);
    setActiveMeasureId(null);
    setCellIdxs(Array(9).fill(0));
    setCellViewports(Array(9).fill(null));
    setActiveCell(0);
  }, [stackSeriesKey]);

  useEffect(() => {
    if (stackInstances.length === 0) return;
    setCellViewports((prev) => prev.map((viewport, cell) => viewport ?? (imageStack[cell] ? viewportFromImage(imageStack[cell]) : null)));
    setCellIdxs((prev) => prev.map((idx) => Math.min(idx, Math.max(0, stackInstances.length - 1))));
  }, [stackSeriesKey, imageStack.length > 0, stackInstances.length]);

  useEffect(() => {
    if (!stackInstances.length) return;
    let cancelled = false;
    const visibleIndexes = [...new Set(cellIdxs.slice(0, cellCount).filter((idx) => Number.isFinite(idx) && idx >= 0 && idx < stackInstances.length))];
    visibleIndexes.forEach((idx) => {
      if (imageStack[idx]) return;
      const instance = stackInstances[idx];
      if (!instance) return;
      loadDicomImage(instance.id)
        .then((image) => {
          if (cancelled) return;
          setImageStack((current) => {
            const next = [...current];
            next[idx] = image;
            return next;
          });
        })
        .catch(() => undefined);
    });
    return () => { cancelled = true; };
  }, [cellIdxs, cellCount, imageStack, stackInstances]);

  // Lay out cells: spread images across cells
  const cellImages = useMemo(() => {
    if (!stackInstances.length) return Array(cellCount).fill(null) as (DicomImage | null)[];
    const step = Math.max(1, Math.floor(stackInstances.length / cellCount));
    return Array.from({ length: cellCount }, (_, i) => {
      const idx = cellIdxs[i] ?? Math.min(i * step, stackInstances.length - 1);
      return imageStack[idx] ?? null;
    });
  }, [cellCount, stackInstances.length, imageStack, cellIdxs]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
    if (stackInstances.length <= 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        setCellIdx(activeCell, Math.min((cellIdxs[activeCell] ?? 0) + 1, stackInstances.length - 1));
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        setCellIdx(activeCell, Math.max((cellIdxs[activeCell] ?? 0) - 1, 0));
      } else if (e.key === 'Escape') {
        setActiveTool('wl');
        setActiveMeasureId(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && activeMeasureId) {
        setMeasurements((prev) => prev.filter((m) => m.id !== activeMeasureId));
        setActiveMeasureId(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [stackInstances.length, activeMeasureId, activeCell, cellIdxs, setCellIdx]);

  useEffect(() => {
    if (activeTool !== 'cine' || stackInstances.length <= 1) return;
    const timer = window.setInterval(() => {
      setCellIdx(activeCell, ((cellIdxs[activeCell] ?? 0) + 1) % stackInstances.length);
    }, 180);
    return () => window.clearInterval(timer);
  }, [activeTool, activeCell, cellIdxs, stackInstances.length, setCellIdx]);

  const addMeasurement = useCallback((m: Measurement) => { setMeasurements((prev) => [...prev, m]); setActiveMeasureId(m.id); }, []);
  const updateMeasurement = useCallback((m: Measurement) => { setMeasurements((prev) => prev.map((p) => p.id === m.id ? m : p)); }, []);
  const deleteMeasurement = useCallback((id: string) => {
    setMeasurements((prev) => prev.filter((m) => m.id !== id));
    setActiveMeasureId((current) => current === id ? null : current);
  }, []);
  const handleMeasureComplete = useCallback(() => { setActiveTool('wl'); }, []);

  const studyInfo = {
    patientName: formatPatientName(study.patientName),
    patientId: study.patientId,
    birthDate: study.patientBirthDate,
    sex: study.patientSex,
    studyDescription: study.studyDescription,
    modality: study.modality,
    studyDate: study.studyDate,
    studyTime: study.studyTime,
  };
  const seriesInfo = { description: activeSeries?.seriesDescription ?? '', number: activeSeries?.seriesNumber ?? 0 };

  const activeImageIndex = cellIdxs[activeCell] ?? 0;
  const activeImage = imageStack[activeImageIndex] ?? imageStack[0] ?? null;
  const activeViewport = cellViewports[activeCell] ?? (activeImage ? viewportFromImage(activeImage) : defaultViewport);
  const setActiveViewport = useCallback((nextViewport: ViewportState) => setCellViewport(activeCell, nextViewport), [activeCell, setCellViewport]);
  const openCompanionScreen = () => {
    const url = new URL('/viewer', window.location.origin);
    url.searchParams.set('study', study.id);
    url.searchParams.set('companion', '1');
    url.hash = sessionFragment();
    const width = Math.min(1100, window.screen.availWidth);
    const height = window.screen.availHeight;
    const companion = window.open(
      url.toString(),
      `pacs-companion-${study.id}`,
      `popup=yes,width=${width},height=${height},left=${window.screen.availWidth},top=0,resizable=yes,scrollbars=no`,
    );
    companion?.focus();
  };
  const resetActiveImage = () => {
    if (activeImage) setActiveViewport(viewportFromImage(activeImage));
  };
  const markKeyImage = () => {
    setKeyImages((prev) => {
      const next = new Set(prev);
      if (next.has(activeImageIndex)) next.delete(activeImageIndex);
      else next.add(activeImageIndex);
      return next;
    });
  };

  const gridClass = layout === '1x2' ? 'grid-cols-2 grid-rows-1' : layout === '2x2' ? 'grid-cols-2 grid-rows-2' : 'grid-cols-3 grid-rows-3';

  return (
    <div className="pacs-viewer flex h-full w-full min-w-0 flex-col overflow-hidden bg-[#090d14]">
      <header className="pacs-viewer-header flex h-14 flex-shrink-0 items-center border-b border-[#164e8d] bg-gradient-to-r from-[#071d3d] via-[#082f65] to-[#082f65] px-3 text-blue-50 shadow-xl">
        <div className="flex w-[217px] flex-shrink-0 items-center gap-2"><div className="h-8 w-8 rounded-lg bg-blue-600 p-1.5"><img src="./brand/pacs-chx-logo.png" alt="PACS CHX" className="h-full w-full object-contain" /></div><div><div className="text-sm font-bold tracking-wide text-white">PACS CHX</div><div className="text-[8px] uppercase tracking-[.2em] text-blue-300">DICOM Viewer</div></div></div>
        <button onClick={() => window.close()} className="mr-3 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[10px] text-blue-100/70 transition hover:bg-white/10 hover:text-white"><ArrowLeft size={14} />Worklist</button>
        <div className="h-7 w-px bg-blue-300/20" />
        <div className="ml-4 min-w-0"><div className="flex items-center gap-2"><User size={14} className="text-blue-400" /><span className="truncate text-xs font-semibold text-white">{formatPatientName(study.patientName)}</span><span className="text-[10px] text-slate-500">{study.patientSex} · {calcAge(study.patientBirthDate)} · {study.patientId}</span></div><div className="mt-0.5 truncate text-[9px] text-slate-400">{study.modality} · {study.studyDescription} · {study.accessionNumber}</div></div>
        <div className="ml-auto flex items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${reportStatus === 'signed' ? 'bg-emerald-400/10 text-emerald-300' : reportStatus === 'draft' ? 'bg-blue-400/10 text-blue-300' : 'bg-amber-400/10 text-amber-300'}`}>{reportStatus === 'signed' ? 'Laudo assinado' : reportStatus === 'draft' ? 'Rascunho salvo' : 'Aguardando laudo'}</span><button onClick={() => setReportPanelOpen((open) => !open)} className={`rounded-lg p-2 ${reportPanelOpen ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400'}`} title="Painel de laudo"><PanelRight size={17} /></button></div>
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">

      {/*  Left series panel  */}
      {seriesPanelOpen && <div
        className="pacs-viewer-series flex flex-col flex-shrink-0 overflow-hidden"
        style={{ width: 230, maxWidth: '34vw', background: 'linear-gradient(180deg,#071d3d,#061a31)', borderRight: '1px solid #164e8d' }}
      >
        {/* Modality tab */}
        <div
          className="flex items-center px-3 py-2 text-xs font-semibold text-white"
          style={{ background: '#082f65', borderBottom: '1px solid #164e8d' }}
        >
          <span className="rounded bg-blue-600/20 px-2 py-1 text-blue-300">IMAGENS ({stackInstances.length})</span>
          <button onClick={() => setSeriesPanelOpen(false)} className="ml-1 text-slate-500 hover:text-white" title="Recolher imagens">x</button>
          <ChevronDown size={11} className="ml-auto text-slate-600" />
        </div>

        {/* Patient info */}
        <div className="px-3 py-2.5" style={{ borderBottom: '1px solid #3f3f46' }}>
          <div className="flex items-center gap-1 text-[11px] text-slate-200">
            <User size={10} className="flex-shrink-0 opacity-60" />
            <span className="truncate">{formatPatientName(study.patientName)}</span>
          </div>
          <div className="mt-1 text-[10px] text-slate-500">
            ID: {study.patientId} · {study.studyDate.replace(/-/g, '/')} {study.studyTime}
          </div>
        </div>

        {/* Separator */}
        <div className="px-2 py-1 text-[11px] text-slate-700" style={{ borderBottom: '1px solid #222' }}></div>

        {/* Thumbnails */}
        <div className="flex-1 overflow-auto py-2 px-2 space-y-1">
          {stackInstances.map((instance, idx) => (
            <StackThumb
              key={instance.id}
              instance={instance}
              index={idx}
              active={idx === activeImageIndex}
              onClick={() => setCellIdx(activeCell, idx)}
            />
          ))}
        </div>
      </div>}

      {/*  Right: toolbar + viewports  */}
      <div className="flex flex-1 flex-col overflow-hidden" style={{ minWidth: 0 }}>

        {/* Toolbar */}
        <div
          className={`flex min-w-0 flex-shrink-0 items-stretch gap-0.5 overflow-x-auto overflow-y-hidden px-2 ${isCompanionScreen ? `viewer-toolbar-companion ${companionToolsExpanded ? 'viewer-toolbar-companion-expanded' : ''}` : ''}`}
          style={{ background: 'linear-gradient(90deg,#071d3d,#082f65)', borderBottom: '1px solid #164e8d' }}
        >
          <ToolBtn icon={<Layers size={16} />} label="Imagens" active={seriesPanelOpen} onClick={() => setSeriesPanelOpen((open) => !open)} />
          <ToolBtn icon={<ImageIcon size={16} />} label="Info" active={showOverlays} onClick={() => setShowOverlays((show) => !show)} />
          <Divider />
          <ToolBtn icon={<Contrast size={16} />} label="Brilho" active={activeTool === 'wl'} onClick={() => setActiveTool('wl')} />
          <ToolBtn icon={<ZoomIn size={16} />} label="Zoom" active={activeTool === 'zoom'} onClick={() => setActiveTool('zoom')} />
          <ToolBtn icon={<RotateCw size={16} />} label="Girar" onClick={() => setActiveViewport({ ...activeViewport, rotation: ((activeViewport.rotation + 90) % 360) as ViewportState['rotation'] })} />
          <ToolBtn icon={<span className="text-sm font-black">D</span>} label="Direita" active={activeTool === 'markD'} onClick={() => setActiveTool(activeTool === 'markD' ? 'wl' : 'markD')} />
          <ToolBtn icon={<span className="text-sm font-black">E</span>} label="Esquerda" active={activeTool === 'markE'} onClick={() => setActiveTool(activeTool === 'markE' ? 'wl' : 'markE')} />
          <ToolBtn icon={<Type size={16} />} label="Texto" active={activeTool === 'text'} onClick={() => setActiveTool(activeTool === 'text' ? 'wl' : 'text')} />
          <ToolBtn icon={<Maximize2 size={16} />} label="Ajustar" onClick={resetActiveImage} />
          <ToolBtn icon={<RotateCcw size={16} />} label="Reset" onClick={() => { resetActiveImage(); setMeasurements([]); setActiveMeasureId(null); }} />
          <ToolBtn icon={<MoreHorizontal size={16} />} label="Limpar" onClick={() => { setMeasurements([]); setActiveMeasureId(null); }} />
          <Divider />          {/* Layout selectors */}
          <ToolBtn icon={<Square size={16} />} label="1x1" active={layout === 'single'} onClick={() => setLayout('single')} />
          <ToolBtn icon={<LayoutTemplate size={16} />} label="1x2" active={layout === '1x2'} onClick={() => setLayout('1x2')} />
          <ToolBtn icon={<Grid2x2 size={16} />} label="2x2" active={layout === '2x2'} onClick={() => setLayout('2x2')} />
          <ToolBtn icon={<Grid3x3 size={16} />} label="3x3" active={layout === '3x3'} onClick={() => setLayout('3x3')} />
          <Divider />
          <ToolBtn icon={<FileText size={16} />} label="Laudo" active={reportPanelOpen} onClick={() => setReportPanelOpen((open) => !open)} />
          {isCompanionScreen && <ToolBtn icon={<ChevronsDown size={16} />} label={companionToolsExpanded ? 'Menos' : 'Mais'} active={companionToolsExpanded} onClick={() => setCompanionToolsExpanded((expanded) => !expanded)} />}
        </div>

        {/* Viewport grid */}
        {imageLoadError && (
          <div className="flex items-center gap-2 border-b border-red-900/50 bg-red-950/60 px-3 py-2 text-[11px] text-red-300">
            <span className="font-semibold">Erro ao carregar imagens:</span>
            <span>{imageLoadError}</span>
          </div>
        )}
        {isImageStackLoading && !imageLoadError && (
          <div className="flex items-center gap-2 border-b border-blue-900/50 bg-[#061a31] px-3 py-2 text-[11px] text-blue-200">
            <RefreshCw size={13} className="animate-spin text-cyan-300" />
            <span>Carregando imagens DICOM</span>
            {stackInstances.length > 0 && <span className="text-blue-400">({imageStack.filter(Boolean).length}/{stackInstances.length})</span>}
          </div>
        )}
        <div
          className={`flex-1 overflow-hidden ${layout !== 'single' ? `grid gap-px ${gridClass}` : 'flex'}`}
          style={{ background: '#18181b', minHeight: 0 }}
        >
          {Array.from({ length: cellCount }, (_, i) => (
            <DicomCanvas
              key={i}
              image={cellImages[i]}
              imageStack={imageStack}
              currentIdx={cellIdxs[i] ?? 0}
              viewport={cellViewports[i] ?? (cellImages[i] ? viewportFromImage(cellImages[i]) : defaultViewport)}
              measurements={activeCell === i ? measurements : []}
              activeMeasureId={activeCell === i ? activeMeasureId : null}
              activeTool={activeTool}
              onViewportChange={(nextViewport) => setCellViewport(i, nextViewport)}
              onCurrentIdxChange={(idx) => {
                if (syncScroll) setCellIdxs((prev) => prev.map((value, cell) => (cell < cellCount ? idx : value)));
                else setCellIdx(i, idx);
              }}
              onAddMeasurement={addMeasurement}
              onUpdateMeasurement={updateMeasurement}
              onSetActiveMeasurement={setActiveMeasureId}
              onDeleteMeasurement={deleteMeasurement}
              onMeasureComplete={handleMeasureComplete}
              onDropImageIndex={(idx) => { setActiveCell(i); setCellIdx(i, Math.max(0, Math.min(idx, stackInstances.length - 1))); }}
              onClick={() => setActiveCell(i)}
              isActive={activeCell === i}
              showOverlays={showOverlays}
              studyInfo={studyInfo}
              seriesInfo={seriesInfo}
            />
          ))}
        </div>
        {(annotationText || keyImages.size > 0 || comparisonMode || !showOverlays) && (
          <div className="flex min-h-8 items-center gap-3 overflow-hidden border-t border-zinc-800 bg-zinc-950 px-3 text-[11px] text-zinc-300">
            {annotationText && <span className="truncate">Anotacao: {annotationText}</span>}
            {keyImages.size > 0 && <span className="shrink-0 text-amber-300">{keyImages.size} key image(s)</span>}
            {comparisonMode && <span className="shrink-0 text-cyan-300">Comparacao ativa</span>}
            {!showOverlays && <span className="shrink-0 text-zinc-500">Overlays ocultos</span>}
          </div>
        )}
      </div>
      {reportPanelOpen && <aside className="pacs-viewer-report flex w-[330px] flex-shrink-0 flex-col border-l border-[#164e8d] bg-gradient-to-b from-[#071d3d] to-[#061a31] text-blue-50">
        <div className="flex items-center gap-2 border-b border-slate-700 px-4 py-3"><FileText size={16} className="text-blue-400" /><span className="text-sm font-semibold">Laudo</span><span className="ml-auto text-[9px] uppercase tracking-wider text-slate-500">{study.modality}</span></div>
        <div className="border-b border-slate-800 px-4 py-4 text-[10px]"><div className="mb-3 text-[9px] font-semibold uppercase tracking-wider text-slate-500">Paciente</div><div className="font-semibold text-white">{formatPatientName(study.patientName)}</div><div className="mt-3 grid grid-cols-2 gap-3"><div><div className="text-slate-500">ID</div><div className="mt-0.5 text-slate-300">{study.patientId}</div></div><div><div className="text-slate-500">Accession</div><div className="mt-0.5 text-slate-300">{study.accessionNumber}</div></div><div className="col-span-2"><div className="text-slate-500">Exame</div><div className="mt-0.5 text-slate-300">{study.studyDescription}</div></div><div><div className="text-slate-500">Data</div><div className="mt-0.5 text-slate-300">{study.studyDate}</div></div><div><div className="text-slate-500">Solicitante</div><div className="mt-0.5 text-slate-300">{study.referringPhysician || 'Não informado'}</div></div></div></div>
        <textarea value={reportText} onChange={(event) => setReportText(event.target.value)} placeholder="Digite o laudo..." className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-xs leading-6 text-slate-200 outline-none placeholder:text-slate-600" />
        <div className="grid grid-cols-2 gap-2 border-t border-slate-700 p-3"><button onClick={() => saveViewerReport('draft')} className="flex items-center justify-center gap-2 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2.5 text-xs font-semibold text-slate-200 hover:bg-slate-700"><Save size={14} />Salvar</button><button onClick={() => saveViewerReport('signed')} disabled={!reportText.trim()} className="flex items-center justify-center gap-2 rounded-lg bg-blue-700 px-3 py-2.5 text-xs font-semibold text-white hover:bg-blue-600 disabled:opacity-40"><CheckCircle2 size={14} />Assinar</button></div>
      </aside>}
      </div>
    </div>
  );
}

