const { generateKeyPairSync, sign, randomBytes } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } = require('node:fs');
const { join } = require('node:path');

const keysDir = join(__dirname, 'keys');
const privatePath = join(keysDir, 'private.pem');
const publicPath = join(keysDir, 'public.pem');
mkdirSync(keysDir, { recursive: true });
if (!existsSync(privatePath) || !existsSync(publicPath)) {
  const pair = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  writeFileSync(privatePath, pair.privateKey, { mode: 0o600 });
  writeFileSync(publicPath, pair.publicKey);
}
copyFileSync(publicPath, join(__dirname, '..', 'server', 'license-public.pem'));

const license = {
  version: 2,
  licenseId: randomBytes(12).toString('hex'),
  customer: 'chx tests',
  machineId: String(process.argv[2] || '').trim().toUpperCase(),
  plan: 'FULL',
  issuedAt: new Date().toISOString(),
  expiresAt: null,
  limits: {
    maxStorageGb: 10000,
    maxDevices: 1000,
    maxUsers: 1000,
    maxStudies: 10000000,
  },
  features: ['dicom-store', 'web-viewer', 'local-import', 'backup'],
};
if (!/^(?:[A-F0-9]{8}-){7}[A-F0-9]{8}$/.test(license.machineId)) throw new Error('Uso: node issue-test-license.cjs CODIGO-DO-SERVIDOR');
const payload = Buffer.from(JSON.stringify(license)).toString('base64url');
const signature = sign(null, Buffer.from(payload), readFileSync(privatePath)).toString('base64url');
const result = { license, key: `CHX1.${payload}.${signature}` };
const outputPath = join(__dirname, 'chx-tests-full.chxlic');
writeFileSync(outputPath, JSON.stringify(result, null, 2));
console.log(outputPath);
