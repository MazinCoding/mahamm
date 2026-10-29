import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';

// Argon2id with OWASP's recommended minimum parameters (19 MiB, t=2, p=1).
const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 128;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMON = new Set(
  readFileSync(path.join(root, 'data', 'common-passwords.txt'), 'utf8')
    .split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean),
);

export function hashPassword(password) {
  return argon2.hash(password, OPTIONS);
}

export async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function needsRehash(hash) {
  try {
    return argon2.needsRehash(hash, OPTIONS);
  } catch {
    return true;
  }
}

// Spend the same time on unknown emails as on real ones, so response
// timing doesn't reveal which accounts exist.
let dummyHash = null;
export async function equaliseTiming(password) {
  dummyHash ??= await hashPassword('timing-equaliser-not-a-real-password');
  await verifyPassword(dummyHash, password);
}

// Returns an i18n key describing the problem, or null if the password is fine.
export async function passwordProblem(password, { email = '', name = '', breachCheck = false } = {}) {
  const pw = String(password || '');
  if (pw.length < MIN_LENGTH) return 'password.tooShort';
  if (pw.length > MAX_LENGTH) return 'password.tooLong';
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) return 'password.common';
  if (/^(.)\1+$/.test(pw)) return 'password.common';
  const local = String(email).split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) return 'password.personal';
  for (const part of String(name).toLowerCase().split(/\s+/)) {
    const clean = part.replace(/^al-/, '');
    if (clean.length >= 4 && lower.includes(clean)) return 'password.personal';
  }
  if (breachCheck && (await isBreached(pw))) return 'password.breached';
  return null;
}

// Have I Been Pwned "range" API: only the first 5 characters of the SHA-1
// hash leave the server (k-anonymity). Fails open if the service is down.
export async function isBreached(password, fetchImpl = globalThis.fetch) {
  try {
    const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
    const res = await fetchImpl(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'mahamm-password-check' },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return false;
    const body = await res.text();
    const suffix = sha1.slice(5);
    return body.split('\n').some((line) => {
      const [hashSuffix, count] = line.trim().split(':');
      return hashSuffix === suffix && Number(count) > 0;
    });
  } catch {
    return false;
  }
}
