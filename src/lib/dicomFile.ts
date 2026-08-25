import type { DicomImage } from '@/types';

type DicomTag = `${string},${string}`;

const LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OW', 'SQ', 'UC', 'UR', 'UT', 'UN']);

interface ParsedElement {
  vr: string;
  offset: number;
  length: number;
}

function tagKey(group: number, element: number): DicomTag {
  return `${group.toString(16).padStart(4, '0')},${element.toString(16).padStart(4, '0')}`;
}

function readAscii(bytes: Uint8Array, offset: number, length: number) {
  return new TextDecoder('ascii').decode(bytes.subarray(offset, offset + length)).replace(/\0+$/, '').trim();
}

function firstNumber(value: string, fallback: number) {
  const number = Number(String(value ?? '').split('\\')[0]);
  return Number.isFinite(number) ? number : fallback;
}

function readNumber(view: DataView, element: ParsedElement, fallback: number) {
  if (element.length < 2) return fallback;
  if (element.vr === 'US') return view.getUint16(element.offset, true);
  if (element.vr === 'SS') return view.getInt16(element.offset, true);
  return firstNumber(readAscii(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), element.offset, element.length), fallback);
}

function parseElements(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let offset = bytes.length > 132 && readAscii(bytes, 128, 4) === 'DICM' ? 132 : 0;
  let explicitVr = true;
  const elements = new Map<DicomTag, ParsedElement>();

  while (offset + 8 <= bytes.length) {
    const group = view.getUint16(offset, true);
    const element = view.getUint16(offset + 2, true);
    const key = tagKey(group, element);
    offset += 4;

    let vr = readAscii(bytes, offset, 2);
    let length: number;
    if (/^[A-Z]{2}$/.test(vr) && explicitVr) {
      offset += 2;
      if (LONG_VR.has(vr)) {
        offset += 2;
        length = view.getUint32(offset, true);
        offset += 4;
      } else {
        length = view.getUint16(offset, true);
        offset += 2;
      }
    } else {
      explicitVr = false;
      vr = '';
      length = view.getUint32(offset, true);
      offset += 4;
    }

    if (length === 0xffffffff || offset + length > bytes.length) break;
    elements.set(key, { vr, offset, length });
    offset += length + (length % 2);
  }

  return { elements, view, bytes };
}

function text(elements: Map<DicomTag, ParsedElement>, bytes: Uint8Array, key: DicomTag, fallback = '') {
  const element = elements.get(key);
  return element ? readAscii(bytes, element.offset, element.length) : fallback;
}

function numberValue(elements: Map<DicomTag, ParsedElement>, view: DataView, key: DicomTag, fallback: number) {
  const element = elements.get(key);
  return element ? readNumber(view, element, fallback) : fallback;
}

export function parseDicomImage(buffer: ArrayBuffer): DicomImage {
  const { elements, view, bytes } = parseElements(buffer);
  const width = numberValue(elements, view, '0028,0011', 0);
  const height = numberValue(elements, view, '0028,0010', 0);
  const bitsAllocated = numberValue(elements, view, '0028,0100', 16);
  const pixelRepresentation = numberValue(elements, view, '0028,0103', 0);
  const photometric = text(elements, bytes, '0028,0004', 'MONOCHROME2');
  const pixelElement = elements.get('7fe0,0010');
  if (!width || !height || !pixelElement) throw new Error('DICOM sem pixels suportados.');

  const pixelCount = width * height;
  const pixelData = new Float32Array(pixelCount);
  if (bitsAllocated <= 8) {
    for (let i = 0; i < pixelCount && i < pixelElement.length; i++) pixelData[i] = bytes[pixelElement.offset + i] ?? 0;
  } else {
    for (let i = 0; i < pixelCount && i * 2 + 1 < pixelElement.length; i++) {
      const offset = pixelElement.offset + i * 2;
      pixelData[i] = pixelRepresentation === 1 ? view.getInt16(offset, true) : view.getUint16(offset, true);
    }
  }

  return {
    width,
    height,
    pixelData,
    pixelSpacing: firstNumber(text(elements, bytes, '0028,0030', '1'), 1),
    sliceThickness: firstNumber(text(elements, bytes, '0018,0050', '1'), 1),
    windowCenter: firstNumber(text(elements, bytes, '0028,1050', '40'), 40),
    windowWidth: firstNumber(text(elements, bytes, '0028,1051', '400'), 400),
    instanceNumber: numberValue(elements, view, '0020,0013', 0),
    sliceLocation: firstNumber(text(elements, bytes, '0020,1041', '0'), 0),
    photometricInterpretation: photometric === 'MONOCHROME1' ? 'MONOCHROME1' : 'MONOCHROME2',
  };
}
