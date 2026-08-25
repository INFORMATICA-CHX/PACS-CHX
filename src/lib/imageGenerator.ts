import type { DicomImage } from '@/types';

// Deterministic pseudo-random generator (mulberry32) so each series
// always produces the same image stack.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Simple value-noise for organic texture
function valueNoise(x: number, y: number, rng: () => number, freq: number): number {
  const xi = Math.floor(x * freq);
  const yi = Math.floor(y * freq);
  const xf = x * freq - xi;
  const yf = y * freq - yi;

  const h = (a: number, b: number) => {
    const n = hashString(`${a},${b}`);
    const r = makeRng(n)();
    return r;
  };

  const v00 = h(xi, yi);
  const v10 = h(xi + 1, yi);
  const v01 = h(xi, yi + 1);
  const v11 = h(xi + 1, yi + 1);

  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);

  const top = v00 + sx * (v10 - v00);
  const bot = v01 + sx * (v11 - v01);
  return top + sy * (bot - top);
}

interface BodyTemplate {
  bodyRadius: number; // fraction of image
  centerX: number;
  centerY: number;
  boneDensity: number;
  tissueDensity: number;
  organs: OrganSpec[];
}

interface OrganSpec {
  cx: number; // relative to center
  cy: number;
  rx: number;
  ry: number;
  density: number;
  label: string;
}

function chestTemplate(): BodyTemplate {
  return {
    bodyRadius: 0.42,
    centerX: 0.5,
    centerY: 0.52,
    boneDensity: 320,
    tissueDensity: 40,
    organs: [
      { cx: -0.08, cy: -0.05, rx: 0.12, ry: 0.14, density: -200, label: 'lung_L' },
      { cx: 0.08, cy: -0.05, rx: 0.12, ry: 0.14, density: -200, label: 'lung_R' },
      { cx: 0, cy: 0.02, rx: 0.06, ry: 0.07, density: 80, label: 'heart' },
      { cx: 0, cy: 0.15, rx: 0.05, ry: 0.04, density: 60, label: 'spine' },
    ],
  };
}

function abdomenTemplate(): BodyTemplate {
  return {
    bodyRadius: 0.44,
    centerX: 0.5,
    centerY: 0.5,
    boneDensity: 300,
    tissueDensity: 60,
    organs: [
      { cx: -0.08, cy: -0.02, rx: 0.08, ry: 0.1, density: 120, label: 'liver' },
      { cx: 0.1, cy: 0.0, rx: 0.06, ry: 0.07, density: 40, label: 'kidney_R' },
      { cx: -0.12, cy: 0.0, rx: 0.06, ry: 0.07, density: 40, label: 'kidney_L' },
      { cx: 0, cy: 0.12, rx: 0.05, ry: 0.04, density: 280, label: 'spine' },
      { cx: 0.15, cy: 0.1, rx: 0.07, ry: 0.05, density: 20, label: 'bowel' },
    ],
  };
}

function headTemplate(): BodyTemplate {
  return {
    bodyRadius: 0.38,
    centerX: 0.5,
    centerY: 0.48,
    boneDensity: 400,
    tissueDensity: 50,
    organs: [
      { cx: -0.1, cy: -0.02, rx: 0.1, ry: 0.12, density: 35, label: 'brain_L' },
      { cx: 0.1, cy: -0.02, rx: 0.1, ry: 0.12, density: 35, label: 'brain_R' },
      { cx: 0, cy: 0.08, rx: 0.04, ry: 0.03, density: 15, label: 'ventricle' },
      { cx: 0, cy: 0.18, rx: 0.06, ry: 0.03, density: 120, label: 'jaw' },
    ],
  };
}

function getTemplate(bodyPart: string): BodyTemplate {
  const bp = bodyPart.toLowerCase();
  if (bp.includes('head') || bp.includes('brain') || bp.includes('skull')) return headTemplate();
  if (bp.includes('chest') || bp.includes('thorax') || bp.includes('lung')) return chestTemplate();
  return abdomenTemplate();
}

const SIZE = 256;

// Generates a single slice of a synthetic DICOM volume.
// sliceProgress goes 0..1 across the stack.
function generateSlice(
  seed: number,
  template: BodyTemplate,
  sliceProgress: number,
): Float32Array {
  const rng = makeRng(seed + Math.floor(sliceProgress * 1000));
  const pixels = new Float32Array(SIZE * SIZE);
  const cx = template.centerX * SIZE;
  const cy = template.centerY * SIZE;
  const bodyR = template.bodyRadius * SIZE;

  // Slice morph factor — organs shift slightly across slices
  const morph = Math.sin(sliceProgress * Math.PI) * 0.9 + 0.1;
  const zShift = (sliceProgress - 0.5) * 0.08;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let value = -1000; // air (CT HU)

      if (dist < bodyR) {
        // Inside body — tissue base
        const edgeFade = 1 - Math.pow(dist / bodyR, 3);
        value = template.tissueDensity * edgeFade;

        // Skin/fat ring
        if (dist > bodyR * 0.9) {
          value = -90;
        }

        // Noise texture
        const n1 = valueNoise(x / SIZE, y / SIZE, rng, 8) * 30;
        const n2 = valueNoise(x / SIZE, y / SIZE, rng, 20) * 15;
        value += (n1 + n2 - 22) * edgeFade;

        // Organs
        for (const organ of template.organs) {
          const ocx = (template.centerX + organ.cx) * SIZE;
          const ocy = (template.centerY + organ.cy + zShift) * SIZE;
          const odx = x - ocx;
          const ody = y - ocy;
          const or = Math.sqrt((odx / (organ.rx * SIZE * morph)) ** 2 + (ody / (organ.ry * SIZE * morph)) ** 2);

          if (or < 1) {
            const fade = 1 - or * or;
            value = value * (1 - fade) + organ.density * fade;
            // organ noise
            value += valueNoise(x / SIZE + organ.cx, y / SIZE + organ.cy, rng, 12) * 12 * fade;
          }
        }

        // Ribs (CT) — bright arcs at certain slice levels
        if (sliceProgress > 0.15 && sliceProgress < 0.85) {
          for (let rib = 0; rib < 6; rib++) {
            const angle = (rib / 6) * Math.PI * 2 + 0.3;
            const ribX = cx + Math.cos(angle) * bodyR * 0.82;
            const ribY = cy + Math.sin(angle) * bodyR * 0.82;
            const rd = Math.sqrt((x - ribX) ** 2 + (y - ribY) ** 2);
            if (rd < 7) {
              value = Math.max(value, template.boneDensity * (1 - rd / 7));
            }
          }
        }

        // Spine — bright circle at center-back
        const spineDx = x - cx;
        const spineDy = y - (cy + bodyR * 0.28 * morph);
        const spineDist = Math.sqrt(spineDx * spineDx + spineDy * spineDy);
        if (spineDist < bodyR * 0.1) {
          value = Math.max(value, template.boneDensity * (1 - spineDist / (bodyR * 0.1)));
        }
      }

      pixels[y * SIZE + x] = value;
    }
  }

  return pixels;
}

// Generates a full stack of synthetic DICOM images for a series.
export function generateImageStack(
  seriesId: string,
  bodyPart: string,
  modality: string,
  count: number,
): DicomImage[] {
  const seed = hashString(seriesId);
  const template = getTemplate(bodyPart);
  const images: DicomImage[] = [];

  // Adjust HU ranges for MR (different scale)
  const isMR = modality === 'MR';
  const wc = isMR ? 300 : 40;
  const ww = isMR ? 600 : 400;

  for (let i = 0; i < count; i++) {
    const progress = count > 1 ? i / (count - 1) : 0.5;
    const sliceLocation = (i - count / 2) * 5; // 5mm spacing
    const pixelData = generateSlice(seed, template, progress);

    images.push({
      width: SIZE,
      height: SIZE,
      pixelData,
      pixelSpacing: 0.8, // mm/px
      sliceThickness: 5,
      windowCenter: wc,
      windowWidth: ww,
      instanceNumber: i + 1,
      sliceLocation,
      photometricInterpretation: 'MONOCHROME2',
    });
  }

  return images;
}

// Applies window/level to raw pixel data and returns RGBA ImageData
// suitable for putImageData on a canvas.
export function applyWindowLevel(
  image: DicomImage,
  windowCenter: number,
  windowWidth: number,
): ImageData {
  const { width, height, pixelData, photometricInterpretation } = image;
  const imageData = new ImageData(width, height);
  const lo = windowCenter - windowWidth / 2;
  const hi = windowCenter + windowWidth / 2;
  const range = hi - lo;

  for (let i = 0; i < pixelData.length; i++) {
    let gray: number;
    if (range <= 0) {
      gray = pixelData[i] >= windowCenter ? 255 : 0;
    } else {
      gray = ((pixelData[i] - lo) / range) * 255;
    }
    gray = Math.max(0, Math.min(255, gray));

    // MONOCHROME1: inverted (0=bright, 255=dark)
    if (photometricInterpretation === 'MONOCHROME1') {
      gray = 255 - gray;
    }

    const idx = i * 4;
    imageData.data[idx] = gray;
    imageData.data[idx + 1] = gray;
    imageData.data[idx + 2] = gray;
    imageData.data[idx + 3] = 255;
  }

  return imageData;
}
