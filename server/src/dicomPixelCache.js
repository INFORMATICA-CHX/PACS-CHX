import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function firstNumber(value, fallback) {
  const candidate = Array.isArray(value) ? value[0] : String(value ?? '').split('\\')[0];
  const number = Number(candidate);
  return Number.isFinite(number) ? number : fallback;
}

function pixelSpacingPair(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split('\\');
  const y = Number(values[0]);
  const x = Number(values[1] ?? values[0]);
  return {
    x: Number.isFinite(x) && x > 0 ? x : null,
    y: Number.isFinite(y) && y > 0 ? y : null,
  };
}

const PIXEL_CACHE_VERSION = 3;

export function buildPixelPayload(meta) {
  let width = Number(meta.Columns ?? 0);
  let height = Number(meta.Rows ?? 0);
  let pixelBuffer = Buffer.from(meta.PixelData instanceof ArrayBuffer ? meta.PixelData : meta.PixelData?.[0] ?? new ArrayBuffer(0));
  if (!pixelBuffer.length) throw new Error('DICOM sem PixelData.');

  const bitsAllocated = Number(meta.BitsAllocated ?? 16);
  const pixelSpacing = pixelSpacingPair(meta.PixelSpacing);
  const imagerPixelSpacing = pixelSpacingPair(meta.ImagerPixelSpacing);

  return {
    cacheVersion: PIXEL_CACHE_VERSION,
    width,
    height,
    bitsAllocated,
    pixelRepresentation: Number(meta.PixelRepresentation ?? 0),
    photometricInterpretation: String(meta.PhotometricInterpretation ?? 'MONOCHROME2'),
    samplesPerPixel: Number(meta.SamplesPerPixel ?? 1),
    windowCenter: firstNumber(meta.WindowCenter, 40),
    windowWidth: firstNumber(meta.WindowWidth, 400),
    pixelSpacing: pixelSpacing.y ?? 1,
    pixelSpacingX: pixelSpacing.x,
    pixelSpacingY: pixelSpacing.y,
    imagerPixelSpacingX: imagerPixelSpacing.x,
    imagerPixelSpacingY: imagerPixelSpacing.y,
    sliceThickness: firstNumber(meta.SliceThickness, 1),
    instanceNumber: Number(meta.InstanceNumber ?? 0),
    sliceLocation: firstNumber(meta.SliceLocation, 0),
    pixelDataBase64: pixelBuffer.toString('base64'),
  };
}

export function pixelCachePathForDicom(filePath) {
  return join(dirname(filePath), `${filePath.split(/[\\/]/).pop()}.pixels.json`);
}

export function readPixelCache(cachePath) {
  if (!cachePath || !existsSync(cachePath)) return null;
  const payload = JSON.parse(readFileSync(cachePath, 'utf8'));
  return payload.cacheVersion === PIXEL_CACHE_VERSION ? payload : null;
}

export function writePixelCache(cachePath, payload) {
  writeFileSync(cachePath, JSON.stringify(payload), { mode: 0o600 });
  return cachePath;
}
