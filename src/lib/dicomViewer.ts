import type { DicomImage, Measurement } from '@/types';

// Low-level rendering for the DICOM viewer.
// This module is intentionally framework-agnostic so it can be reused
// across single-view and grid-view components.

export interface ViewportState {
  windowCenter: number;
  windowWidth: number;
  zoom: number;
  panX: number;
  panY: number;
  invert: boolean;
  flipH: boolean;
  flipV: boolean;
  rotation: 0 | 90 | 180 | 270;
}

export const defaultViewport: ViewportState = {
  windowCenter: 40,
  windowWidth: 400,
  zoom: 1,
  panX: 0,
  panY: 0,
  invert: false,
  flipH: false,
  flipV: false,
  rotation: 0,
};

export function viewportFromImage(image: DicomImage): ViewportState {
  return {
    ...defaultViewport,
    windowCenter: image.windowCenter,
    windowWidth: image.windowWidth,
  };
}

// Canvas transform helpers
function applyTransform(ctx: CanvasRenderingContext2D, vp: ViewportState, canvasW: number, canvasH: number, imgW: number, imgH: number) {
  const baseScale = Math.min(canvasW / imgW, canvasH / imgH);
  const scale = baseScale * vp.zoom;
  ctx.save();
  ctx.translate(canvasW / 2 + vp.panX, canvasH / 2 + vp.panY);
  ctx.rotate((vp.rotation * Math.PI) / 180);
  if (vp.flipH) ctx.scale(-1, 1);
  if (vp.flipV) ctx.scale(1, -1);
  ctx.scale(scale, scale);
  ctx.translate(-imgW / 2, -imgH / 2);
}

// Cache of rendered canvas per image object + window/level pair.
// Uses a WeakMap keyed on the DicomImage reference so different series
// with the same instanceNumber don't collide.
const imageCanvasCache = new WeakMap<DicomImage, Map<string, HTMLCanvasElement>>();

function getCachedImageCanvas(image: DicomImage, wc: number, ww: number, invert: boolean): HTMLCanvasElement {
  let perImage = imageCanvasCache.get(image);
  if (!perImage) {
    perImage = new Map();
    imageCanvasCache.set(image, perImage);
  }
  const roundedWc = Math.round(wc);
  const roundedWw = Math.max(1, Math.round(ww));
  const key = `${roundedWc}_${roundedWw}_${invert}`;
  const cached = perImage.get(key);
  if (cached) return cached;

  // Build base grayscale from pixel data + window/level
  const { width, height, pixelData, photometricInterpretation } = image;
  const data = new ImageData(width, height);
  const lo = roundedWc - roundedWw / 2;
  const range = roundedWw;

  for (let i = 0; i < pixelData.length; i++) {
    let gray = ((pixelData[i] - lo) / range) * 255;
    gray = Math.max(0, Math.min(255, gray));
    if (photometricInterpretation === 'MONOCHROME1') gray = 255 - gray;
    if (invert) gray = 255 - gray;
    const idx = i * 4;
    data.data[idx] = gray;
    data.data[idx + 1] = gray;
    data.data[idx + 2] = gray;
    data.data[idx + 3] = 255;
  }

  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const canvasCtx = canvas.getContext('2d')!;
  canvasCtx.putImageData(data, 0, 0);
  perImage.set(key, canvas);
  return canvas;
}

export function renderImage(
  ctx: CanvasRenderingContext2D,
  image: DicomImage,
  vp: ViewportState,
  canvasW: number,
  canvasH: number,
) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvasW, canvasH);
  if (!image) return;

  const imageCanvas = getCachedImageCanvas(image, vp.windowCenter, vp.windowWidth, vp.invert);

  applyTransform(ctx, vp, canvasW, canvasH, image.width, image.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(imageCanvas, 0, 0);
  ctx.restore();
}

// Convert a screen coordinate to image-space coordinate (accounting for zoom/pan/rotation)
export function screenToImage(
  sx: number,
  sy: number,
  vp: ViewportState,
  canvasW: number,
  canvasH: number,
  imgW: number,
  imgH: number,
): { x: number; y: number } {
  const baseScale = Math.min(canvasW / imgW, canvasH / imgH);
  const scale = baseScale * vp.zoom;

  // Undo translate to center + pan
  const x = (sx - canvasW / 2 - vp.panX) / scale;
  const y = (sy - canvasH / 2 - vp.panY) / scale;

  // Undo rotation
  const rad = (-vp.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rx = x * cos - y * sin;
  const ry = x * sin + y * cos;

  // Undo flip
  let finalX = vp.flipH ? -rx : rx;
  let finalY = vp.flipV ? -ry : ry;

  // Undo center translate
  finalX += imgW / 2;
  finalY += imgH / 2;

  return { x: finalX, y: finalY };
}

export function renderMeasurements(
  ctx: CanvasRenderingContext2D,
  measurements: Measurement[],
  vp: ViewportState,
  canvasW: number,
  canvasH: number,
  imgW: number,
  imgH: number,
  pixelSpacing: number,
  activeId: string | null,
) {
  for (const m of measurements) {
    const minPoints = m.type === 'angle' ? 3 : m.type === 'marker' || m.type === 'text' ? 1 : 2;
    if (m.points.length < minPoints) continue;

    // Convert image points to screen points
    const screenPoints = m.points.map((p) => imageToScreen(p.x, p.y, vp, canvasW, canvasH, imgW, imgH));

    ctx.save();
    ctx.strokeStyle = m.id === activeId ? '#fbbf24' : '#22d3ee';
    ctx.lineWidth = 2;
    ctx.setLineDash(m.id === activeId ? [] : []);

    if (m.type === 'length') {
      const [a, b] = screenPoints;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      // Endpoints
      for (const p of screenPoints) {
        ctx.fillStyle = m.id === activeId ? '#fbbf24' : '#22d3ee';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // Label
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const px = Math.hypot(m.points[1].x - m.points[0].x, m.points[1].y - m.points[0].y) * pixelSpacing;
      drawLabel(ctx, midX, midY, `${px.toFixed(1)} mm`, m.id === activeId);
    } else if (m.type === 'angle') {
      const [a, b, c] = screenPoints;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.stroke();

      for (const p of screenPoints) {
        ctx.fillStyle = m.id === activeId ? '#fbbf24' : '#22d3ee';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      const midX = b.x;
      const midY = b.y - 16;
      drawLabel(ctx, midX, midY, `${m.value ?? 0}°`, m.id === activeId);
    } else if (m.type === 'marker' || m.type === 'text') {
      const [p] = screenPoints;
      drawLabel(ctx, p.x, p.y, m.label || (m.type === 'marker' ? 'D' : 'Texto'), m.id === activeId);
    }

    ctx.restore();
  }
}

export function imageToScreen(
  ix: number,
  iy: number,
  vp: ViewportState,
  canvasW: number,
  canvasH: number,
  imgW: number,
  imgH: number,
): { x: number; y: number } {
  let x = ix - imgW / 2;
  let y = iy - imgH / 2;

  if (vp.flipH) x = -x;
  if (vp.flipV) y = -y;

  const rad = (vp.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rx = x * cos - y * sin;
  const ry = x * sin + y * cos;

  const baseScale = Math.min(canvasW / imgW, canvasH / imgH);
  const scale = baseScale * vp.zoom;
  return {
    x: rx * scale + canvasW / 2 + vp.panX,
    y: ry * scale + canvasH / 2 + vp.panY,
  };
}

function drawLabel(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, active: boolean) {
  ctx.font = '13px ui-monospace, monospace';
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = active ? 'rgba(251, 191, 36, 0.9)' : 'rgba(34, 211, 238, 0.85)';
  ctx.fillRect(x - w / 2, y - 10, w, 18);
  ctx.fillStyle = '#0a0a0a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

// Compute angle between three points (b is the vertex)
export function computeAngle(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const dot = v1x * v2x + v1y * v2y;
  const mag1 = Math.hypot(v1x, v1y);
  const mag2 = Math.hypot(v2x, v2y);
  if (mag1 === 0 || mag2 === 0) return 0;
  const cos = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
  return Math.round((Math.acos(cos) * 180) / Math.PI);
}

export function computeLength(p1: { x: number; y: number }, p2: { x: number; y: number }, pixelSpacing: number): number {
  return Math.hypot(p2.x - p1.x, p2.y - p1.y) * pixelSpacing;
}
