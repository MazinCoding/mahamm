import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';

const PERIOD = 30;

function totpFor(secret, label = 'user', issuer = 'Mahamm') {
  return new OTPAuth.TOTP({ issuer, label, algorithm: 'SHA1', digits: 6, period: PERIOD, secret: OTPAuth.Secret.fromBase32(secret) });
}

export function newTotpSecret() {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export async function totpQrDataUrl(secret, label, issuer) {
  return QRCode.toDataURL(totpFor(secret, label, issuer).toString(), { margin: 1, width: 220 });
}

// Returns the accepted time step, or null. A code can only be used once:
// the step must be newer than the last one accepted for this account.
export function verifyTotp(secret, token, lastStep = 0) {
  const code = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const delta = totpFor(secret).validate({ token: code, window: 1 });
  if (delta === null) return null;
  const step = Math.floor(Date.now() / 1000 / PERIOD) + delta;
  if (step <= Number(lastStep)) return null;
  return step;
}

// Test helper.
export function currentCode(secret) {
  return totpFor(secret).generate();
}
