import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';

/** 256-bit opaque token for the participant QR. Only its hash is stored. */
export const newToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const hmac = (secret: string, s: string) => createHmac('sha256', secret).update(s).digest('hex');
export const otpCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** Accepts a scanned value: full portal URL, bare token, or registration code. */
export function parseScan(raw: string): { code: string | null; tokenHash: string | null } {
  const v = raw.trim();
  const m = v.match(/\/p\/([A-Za-z0-9_-]{40,})/);
  if (m) return { code: null, tokenHash: sha256(m[1]) };
  if (/^[A-Za-z0-9_-]{43}$/.test(v)) return { code: null, tokenHash: sha256(v) };
  return { code: v.toUpperCase(), tokenHash: null };
}
