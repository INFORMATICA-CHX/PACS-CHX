const { existsSync, mkdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = join(__dirname, '..');
const source = join(root, 'service', 'PacsChxServiceHost.cs');
const outputDir = join(root, 'service', 'bin');
const output = join(outputDir, 'PacsChxServiceHost.exe');
const windir = process.env.WINDIR || 'C:\\Windows';
const csc = join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

if (!existsSync(csc)) {
  throw new Error(`Compilador C# nao encontrado em ${csc}`);
}

mkdirSync(outputDir, { recursive: true });
if (existsSync(output)) rmSync(output, { force: true });

const result = spawnSync(csc, [
  '/nologo',
  '/target:exe',
  '/optimize+',
  '/platform:x64',
  `/out:${output}`,
  '/reference:System.ServiceProcess.dll',
  source,
], { stdio: 'inherit' });

if (result.status !== 0) {
  throw new Error(`Falha ao compilar PacsChxServiceHost.exe (codigo ${result.status})`);
}

console.log(`Service host preparado em ${output}`);
