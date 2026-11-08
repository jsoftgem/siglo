import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const keyDirectory = resolve(__dirname, '../../signed-order-intake/.local');
const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});
mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
// Refuse to overwrite existing keys, so a running server never silently changes identity.
writeFileSync(resolve(keyDirectory, 'client-private.pem'), privateKey, { mode: 0o600, flag: 'wx' });
writeFileSync(resolve(keyDirectory, 'client-public.pem'), publicKey, { mode: 0o644, flag: 'wx' });
console.log(`Created demo client keys in ${keyDirectory}`);
