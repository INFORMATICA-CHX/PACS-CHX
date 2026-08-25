const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { build } = require('esbuild');
const bytenode = require('bytenode');

async function main() {
  const projectRoot = join(__dirname, '..');
  const outputDir = join(projectRoot, 'server', 'build');
  const bundlePath = join(outputDir, 'server.bundle.cjs');
  const bytecodePath = join(outputDir, 'server.jsc');
  mkdirSync(outputDir, { recursive: true });
  await build({
    entryPoints: [join(projectRoot, 'server', 'src', 'index.js')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    packages: 'external',
    sourcemap: false,
    minify: true,
  });
  try {
    await bytenode.compileFile({ filename: bundlePath, output: bytecodePath, compileAsModule: true });
  } catch (error) {
    console.warn(`Bytecode nao gerado: ${error.message}`);
  }
  writeFileSync(join(outputDir, 'server-loader.cjs'), `
try {
  require('bytenode');
  require('./server.jsc');
} catch (error) {
  if (!/cached data|cachedDataRejected|Invalid or incompatible/i.test(String(error && error.message))) throw error;
  console.warn('[PACS CHX] Bytecode incompativel com este runtime; usando bundle JavaScript.');
  require('./server.bundle.cjs');
}
`);
  console.log(`Servidor preparado em ${outputDir}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
