const KONICA_ANATOMY_RULES: Array<[string, string]> = [
  ['sternoclavicular', 'ARTICULACAO ESTERNOCLAVICULAR'],
  ['acromioclavicular', 'ARTICULACAO ACROMIOCLAVICULAR'],
  ['sacroiliac', 'ARTICULACAO SACROILIACA'],
  ['thoracolumbar', 'COLUNA TORACOLOMBAR'],
  ['lumbosacral', 'COLUNA LOMBOSSACRA'],
  ['spine, cervical', 'COLUNA CERVICAL'],
  ['spine; thoracic', 'COLUNA TORACICA'],
  ['sacrum and coccyx', 'SACRO E COCCIX'],
  ['lower extremity', 'MEMBRO INFERIOR'],
  ['facial bones', 'OSSOS DA FACE'],
  ['nasal bones', 'OSSOS NASAIS'],
  ['optic foramina', 'ORBITAS'],
  ['paranasal', 'SEIOS DA FACE'],
  ['mandible', 'MANDIBULA'],
  ['mastoids', 'MASTOIDES'],
  ['orbits', 'ORBITAS'],
  ['eye', 'OLHOS'],
  ['skull', 'CRANIO'],
  ['neck', 'PESCOCO'],
  ['ribs', 'ARCOS COSTAIS'],
  ['sternum', 'ESTERNO'],
  ['abdomen', 'ABDOMEN'],
  ['chest', 'TORAX'],
  ['clavicle', 'CLAVICULA'],
  ['scapula', 'ESCAPULA'],
  ['shoulder', 'OMBRO'],
  ['humerus', 'UMERO'],
  ['elbow', 'COTOVELO'],
  ['forearm', 'ANTEBRACO'],
  ['wrist', 'PUNHO'],
  ['thumb', 'POLEGAR'],
  ['finger', 'DEDOS DA MAO'],
  ['hand', 'MAO'],
  ['pelvis and hips', 'QUADRIL'],
  ['hips', 'QUADRIL'],
  [' hip', 'QUADRIL'],
  ['pelvis', 'BACIA'],
  ['femur', 'FEMUR'],
  ['knee', 'JOELHO'],
  ['tibia and fibula', 'PERNA'],
  ['ankle', 'TORNOZELO'],
  ['calcaneus', 'CALCANEO'],
  ['toe', 'DEDOS DO PE'],
  ['feet', 'PE'],
  [' foot', 'PE'],
];

export function translateKonicaDescription(text: string): string {
  const normalized = String(text ?? '').trim().toLowerCase();
  return KONICA_ANATOMY_RULES.find(([term]) => normalized.includes(term))?.[1] || String(text ?? '').trim().toUpperCase();
}

const KONICA_PROJECTION_RULES: Record<string, { name: string; viewPosition: string }> = {
  '0000/0100': { name: 'ESCAFOIDE', viewPosition: 'OBL' },
  '0010': { name: 'FRONTAL AP', viewPosition: 'AP' },
  '0011': { name: 'FRONTAL AP', viewPosition: 'AP' },
  '0012': { name: 'FRONTAL PA', viewPosition: 'PA' },
  '0013': { name: 'LATERAL', viewPosition: 'LAT' },
  '0014': { name: 'LATERAL DIREITA', viewPosition: 'LAT' },
  '0015': { name: 'LATERAL ESQUERDA', viewPosition: 'LAT' },
  '0016': { name: 'OBLIQUA', viewPosition: 'OBL' },
  '0017': { name: 'OBLIQUA DIREITA', viewPosition: 'OBL' },
  '0018': { name: 'OBLIQUA ESQUERDA', viewPosition: 'OBL' },
  '0021': { name: 'AXIAL', viewPosition: 'AXIAL' },
  '0022': { name: 'OBLIQUA', viewPosition: 'OBL' },
  '0024': { name: 'DECUBITO', viewPosition: 'DECUBITUS' },
  '0030': { name: 'LORDOTICA', viewPosition: 'AP' },
  '0034': { name: 'TOWNE', viewPosition: 'AP' },
  '0036': { name: 'WATERS', viewPosition: 'PA' },
  '0037': { name: 'CALDWELL', viewPosition: 'PA' },
  '0042': { name: 'RHESE', viewPosition: 'OBL' },
  '0047': { name: 'Y ESCAPULAR', viewPosition: 'LAT' },
  '5400': { name: 'FLEXAO', viewPosition: 'LAT' },
  '5500': { name: 'EXTENSAO', viewPosition: 'LAT' },
  '5600': { name: 'FRONTAL AP PEDIATRICA', viewPosition: 'AP' },
  '5700': { name: 'PERFIL RA', viewPosition: 'LAT' },
  '5800': { name: 'TRANSORAL ODONTOIDE', viewPosition: 'AP' },
  '7100': { name: 'ROTACAO INTERNA', viewPosition: 'AP' },
  '7300': { name: 'ROTACAO EXTERNA', viewPosition: 'AP' },
};

export function konicaProjection(protocolCode: string): { name: string; viewPosition: string; encodedLaterality: string } {
  const code = String(protocolCode ?? '').trim();
  if (!/^\d{16}$/.test(code)) return { name: 'PROJECAO ESPECIAL', viewPosition: '', encodedLaterality: '' };
  const viewKey = code.slice(8, 12);
  const tail = code.slice(12, 16);
  if (viewKey === '7000') {
    return { name: tail === '0001' ? 'ARTICULACAO AC COM CARGA' : 'ARTICULACAO AC SEM CARGA', viewPosition: 'AP', encodedLaterality: '' };
  }
  const rule = KONICA_PROJECTION_RULES[`${viewKey}/${tail}`] || KONICA_PROJECTION_RULES[viewKey];
  const encodedLaterality = tail === '0001' ? 'R' : tail === '0002' ? 'L' : '';
  return { name: rule?.name || `PROJECAO ${viewKey}`, viewPosition: rule?.viewPosition || '', encodedLaterality };
}

export function nameKonicaIncidences(protocolCodes: string[], risCode: string, knownSideByCode: Map<string, 'L' | 'R'> = new Map()) {
  const explicitRisSide = risCode.endsWith('L') ? 'L' : risCode.endsWith('R') ? 'R' : '';
  const base = protocolCodes.map((protocolCode) => {
    const projection = konicaProjection(protocolCode);
    return { protocolCode, ...projection, side: explicitRisSide || knownSideByCode.get(protocolCode) || projection.encodedLaterality };
  });
  const totals = new Map<string, number>();
  base.forEach((item) => totals.set(`${item.protocolCode}|${item.name}|${item.side}`, (totals.get(`${item.protocolCode}|${item.name}|${item.side}`) || 0) + 1));
  const seen = new Map<string, number>();
  return base.map((item) => {
    const key = `${item.protocolCode}|${item.name}|${item.side}`;
    const occurrence = (seen.get(key) || 0) + 1;
    seen.set(key, occurrence);
    let side = item.side;
    if (!side && totals.get(key) === 2) side = occurrence === 1 ? 'R' : 'L';
    const sideName = side === 'L' ? 'ESQUERDA' : side === 'R' ? 'DIREITA' : '';
    const alreadySided = /\b(DIREITA|ESQUERDA)$/.test(item.name);
    const name = sideName && !alreadySided ? `${item.name} ${sideName}` : item.name;
    return { ...item, side, name };
  });
}
