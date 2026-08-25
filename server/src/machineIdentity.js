import { createHash, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SOURCE_NAMES = ['machine', 'disk', 'bios'];
const INVALID_VALUES = new Set(['', 'none', 'null', 'unknown', 'default string', 'to be filled by o.e.m.', '00000000-0000-0000-0000-000000000000']);

function command(file, args) {
  try { return execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

function validValue(value) {
  const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');
  return INVALID_VALUES.has(normalized.toLowerCase()) ? '' : normalized;
}

function powershell(script) {
  return validValue(command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]).split(/\r?\n/).find(validValue));
}

function windowsSources() {
  const registry = command('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
  const machine = validValue(registry.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i)?.[1]);
  const disk = powershell("$letter=$env:SystemDrive.TrimEnd(':'); (Get-Partition -DriveLetter $letter | Get-Disk | Select-Object -First 1 -ExpandProperty SerialNumber)")
    || validValue(command('wmic.exe', ['diskdrive', 'get', 'SerialNumber', '/value']).match(/SerialNumber=([^\r\n]+)/i)?.[1]);
  const bios = powershell('(Get-CimInstance Win32_ComputerSystemProduct | Select-Object -First 1 -ExpandProperty UUID)')
    || validValue(command('wmic.exe', ['csproduct', 'get', 'UUID', '/value']).match(/UUID=([^\r\n]+)/i)?.[1]);
  return { machine, disk, bios };
}

function linuxSources() {
  let machine = '';
  let disk = '';
  let bios = '';
  try { machine = validValue(readFileSync('/etc/machine-id', 'utf8')); } catch { /* unavailable */ }
  try { disk = validValue(readFileSync('/sys/class/block/sda/device/serial', 'utf8')); } catch { /* unavailable */ }
  try { bios = validValue(readFileSync('/sys/class/dmi/id/product_uuid', 'utf8')); } catch { /* unavailable */ }
  return { machine, disk, bios };
}

function rawSources() {
  if (process.platform === 'win32') return windowsSources();
  if (process.platform === 'linux') return linuxSources();
  throw new Error(`Plataforma ${process.platform} sem suporte ao fingerprint multifonte.`);
}

function sourceDigest(name, value) {
  return createHash('sha256').update(`PACS-CHX-LICENSE-V3\0${name}\0${value}`).digest('hex').toUpperCase();
}

export function machineFingerprint() {
  const raw = rawSources();
  const sources = Object.fromEntries(SOURCE_NAMES.filter((name) => raw[name]).map((name) => [name, sourceDigest(name, raw[name])]));
  if (Object.keys(sources).length < 2) {
    throw new Error('Fingerprint de maquina inconfiavel: menos de duas fontes de hardware disponiveis. Execute o License Manager localmente para diagnostico.');
  }
  return { version: 3, sources };
}

export function encodeMachineFingerprint(fingerprint = machineFingerprint()) {
  const canonical = Object.fromEntries(SOURCE_NAMES.filter((name) => fingerprint.sources[name]).map((name) => [name, fingerprint.sources[name]]));
  return `CHX3.${Buffer.from(JSON.stringify(canonical)).toString('base64url')}`;
}

export function decodeMachineFingerprint(value) {
  const [prefix, payload, extra] = String(value ?? '').trim().split('.');
  if (prefix !== 'CHX3' || !payload || extra) throw new Error('Codigo de servidor multifonte invalido.');
  const sources = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const entries = Object.entries(sources).filter(([name, digest]) => SOURCE_NAMES.includes(name) && /^[A-F0-9]{64}$/.test(String(digest)));
  if (entries.length < 2) throw new Error('Codigo de servidor sem fontes de hardware suficientes.');
  return { version: 3, sources: Object.fromEntries(entries) };
}

export function matchingFingerprintSources(licensed, current) {
  let matches = 0;
  for (const name of SOURCE_NAMES) {
    const left = licensed.sources[name];
    const right = current.sources[name];
    if (!left || !right) continue;
    const expected = Buffer.from(left);
    const actual = Buffer.from(right);
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) matches += 1;
  }
  return matches;
}

export function legacyMachineId() {
  const machine = rawSources().machine;
  if (!machine) throw new Error('Identificador legado da maquina indisponivel.');
  const digest = createHash('sha256').update(`PACS-CHX-LICENSE-V2\0${machine}`).digest('hex').toUpperCase();
  return digest.match(/.{1,8}/g).join('-');
}

export function machineId() {
  return encodeMachineFingerprint();
}
