import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

// Thin wrappers over Node's built-in crypto. No custom algorithms.

let encKey = null;
let hmacKey = null;

export function initCrypto(dataKey) {
  const ikm = Buffer.from(dataKey, 'utf8');
  encKey = Buffer.from(hkdfSync('sha256', ikm, 'mahamm', 'field-encryption', 32));
  hmacKey = Buffer.from(hkdfSync('sha256', ikm, 'mahamm', 'recovery-codes', 32));
}

// Random, URL-safe token for invite and reset links (256 bits).
export function newToken() {
  return randomBytes(32).toString('base64url');
}

// Tokens are stored only as hashes, so a database leak exposes no live links.
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

// AES-256-GCM for sensitive fields at rest (two-step secrets).
export function encryptField(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decryptField(stored) {
  const [v, iv, tag, ct] = String(stored).split(':');
  if (v !== 'v1') throw new Error('Unknown field encryption version');
  const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(10);
    let s = '';
    for (const b of bytes) s += B32[b % B32.length];
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

export function normalizeRecoveryCode(code) {
  return String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashRecoveryCode(code) {
  return createHmac('sha256', hmacKey).update(normalizeRecoveryCode(code)).digest('hex');
}
