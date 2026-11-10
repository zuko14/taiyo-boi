import { describe, expect, it } from 'vitest';
import { toCsv } from '@/lib/csv';
import { friendlyError } from '@/lib/errors';
import { inr, isoToLocalInput, localInputToIso, statusLabel, toPaise } from '@/lib/format';
import { labelSettings } from '@/lib/label';
import { newToken, parseScan, sha256 } from '@/lib/tokens';

describe('tokens', () => {
  it('generates 256-bit url-safe tokens', () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(Array.from({ length: 200 }, newToken)).size).toBe(200);
  });
  it('parses a scanned portal URL into a token hash, never sending the raw token', () => {
    const t = newToken();
    expect(parseScan(`https://camp.example.org/p/${t}`)).toEqual({ code: null, tokenHash: sha256(t) });
    expect(parseScan(t)).toEqual({ code: null, tokenHash: sha256(t) });
  });
  it('normalises registration codes', () => {
    expect(parseScan('  boi-f-2026-000001 ')).toEqual({ code: 'BOI-F-2026-000001', tokenHash: null });
  });
});

describe('csv', () => {
  it('quotes and neutralises formula injection', () => {
    const out = toCsv([{ a: 'x,y', b: '=HYPERLINK("evil")', c: 'line\nbreak', d: null }]);
    expect(out).toBe('a,b,c,d\r\n"x,y","\'=HYPERLINK(""evil"")","line\nbreak",\r\n');
  });
});

describe('format', () => {
  it('formats paise as INR and parses rupees safely', () => {
    expect(inr(299900)).toContain('2,999');
    expect(toPaise('500.50')).toBe(50050);
    expect(() => toPaise('-1')).toThrow();
    expect(() => toPaise('abc')).toThrow();
  });
  it('round-trips datetime-local values in IST', () => {
    const iso = localInputToIso('2026-11-20T09:30', 'Asia/Kolkata');
    expect(iso).toBe('2026-11-20T04:00:00.000Z');
    expect(isoToLocalInput(iso, 'Asia/Kolkata')).toBe('2026-11-20T09:30');
  });
  it('uses plain-language labels', () => {
    expect(statusLabel('waiting_unassigned')).toBe('No station free');
    expect(statusLabel('uploaded_pending_validation')).toBe('Pending validation');
  });
});

describe('errors', () => {
  it('maps database exception prefixes to plain language', () => {
    expect(friendlyError({ message: 'permission_denied: payment.verify' })).toMatch(/permission/);
    expect(friendlyError({ message: 'not_on_duty: you have no active shift at ECG Room 1' })).toMatch(/active shift/);
    expect(friendlyError({ message: 'weird', code: '57014' })).toMatch(/retry/);
  });
});

describe('label settings', () => {
  it('defaults until real label stock is configured', () => {
    expect(labelSettings({})).toEqual({ w: 90, h: 55, showAge: true });
    expect(labelSettings({ label: { width_mm: 100, height_mm: 50, show_age: false } })).toEqual({ w: 100, h: 50, showAge: false });
  });
});
