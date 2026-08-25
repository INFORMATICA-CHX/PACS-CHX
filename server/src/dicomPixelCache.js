import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function firstNumber(value, fallback) {
  const candidate = Array.isArray(value) ? value[0] : String(value ?? '').split('\\')[0];
  const number = Number(candidate);
  return Number.isFinite(number) ? number : fallback;
}

function firstPixelSpacing(value) {
  if (Array.isArray(value) && value.length) return Number(value[0]) || 1;
  const number = Number(String(value ?? '').split('\\')[0]);
  return Number.isFinite(number) && number > 0 ? number : 1;
}

const PIXEL_CACHE_VERSION = 2;

export function buildPixelPayload(meta) {
  let width = Number(meta.Columns ?? 0);
  let height = Number(meta.Rows ?? 0);
  let pixelBuffer = Buffer.from(meta.PixelData instanceof ArrayBuffer ? meta.PixelData : meta.PixelData?.[0] ?? new ArrayBuffer(0));
  if (!pixelBuffer.length) throw new Error('DICOM sem PixelData.');

  const bitsAllocated = Number(meta.BitsAllocated ?? 16);

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
    pixelSpacing: firstPixelSpacing(meta.PixelSpacing),
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
