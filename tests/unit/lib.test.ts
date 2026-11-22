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

import { upiLink, upiPayee } from '@/lib/upi';
describe('upi', () => {
  it('builds an NPCI pay link with exact amount, literal @ and %20 spaces', () => {
    const p = upiPayee({ upi_vpa: 'lab.pay@okicici', upi_payee_name: 'Taiyo Labs Pvt Ltd' })!;
    expect(upiLink(p, 49950, 'BOI-B-2026-000001')).toBe('upi://pay?pa=lab.pay@okicici&pn=Taiyo%20Labs%20Pvt%20Ltd&am=499.50&cu=INR&tn=BOI-B-2026-000001');
  });
  it('rejects malformed UPI IDs', () => {
    expect(upiPayee({ upi_vpa: 'not a vpa' })).toBeNull();
    expect(upiPayee({})).toBeNull();
  });
});

import { mapCatalog, parseCsv, priceToPaise } from '@/lib/catalog-import';
describe('catalogue import', () => {
  it('parses quoted CSV with commas, escaped quotes, CRLF and BOM', () => {
    expect(parseCsv('﻿a,"b,c","d ""q"""\r\n1,2,3')).toEqual([['a', 'b,c', 'd "q"'], ['1', '2', '3']]);
  });
  it('reads the lab MRP sheet layout: title rows, aliases, totals rows, generated unique codes', () => {
    const csv = 'MASTER LIST,,,\nS. No,Category,Test Description,MRP (INR)\n1,Thyroid,TSH,"₹1,200"\n2,Thyroid,TSH,300\n,TOTAL / AVERAGE SUMMARY,,\n';
    const r = mapCatalog(parseCsv(csv));
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.code, x.name, x.category, x.price_paise, x.location])).toEqual([
      ['TSH', 'TSH', 'Thyroid', 120000, 'event_day'], ['TSH-2', 'TSH', 'Thyroid', 30000, 'event_day']]);
  });
  it('round-trips the template columns and reports bad rows with line numbers', () => {
    const r = mapCatalog(parseCsv("code,name,category,price_inr,location,service\nECG,ECG,Cardiac,400,event_day,ecg\nX,Bad price,,abc,,\nUSG,USG,,1500,walkin,\nDUP,'=Name,,,,\nDUP,Again,,,,\n"));
    expect(r.rows.find((x) => x.code === 'ECG')?.service_code).toBe('ECG');
    expect(r.rows.find((x) => x.code === 'USG')?.location).toBe('walk_in');
    expect(r.rows.find((x) => x.code === 'DUP')?.name).toBe('=Name');
    expect(r.errors.map((e) => e.line)).toEqual([3, 6]);
  });
  it('prices', () => {
    expect(priceToPaise('Rs. 1,499.50')).toBe(149950);
    expect(priceToPaise('')).toBeNull();
    expect(priceToPaise('12.345')).toBe('invalid');
  });
});

import { mapPackages } from '@/lib/catalog-import';
describe('package import', () => {
  it('expands a ;-separated test list and keeps one price per package', () => {
    const r = mapPackages(parseCsv('package_code,package_name,code_letter,price_inr,test\nAARUSH,Taiyo Aarush Executive Plus,A,"₹4,499",FBS; HbA1c; CBC\nAARUSH,,,,2D Echo\nBASIC,Basic,B,999,CBC\n'));
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.package_code, x.test, x.price_paise])).toEqual([
      ['AARUSH', 'FBS', 449900], ['AARUSH', 'HbA1c', 449900], ['AARUSH', 'CBC', 449900], ['AARUSH', '2D Echo', null], ['BASIC', 'CBC', 99900]]);
  });
  it('rejects conflicting prices and bad codes', () => {
    const r = mapPackages(parseCsv('package_code,price_inr,test\nA,100,CBC\nA,200,LFT\nbad code!,,CBC\n'));
    expect(r.errors.map((e) => e.line)).toEqual([3, 4]);
  });
});

describe('discounts', () => {
  it('rounds like the database and parses percentages', async () => {
    const { discounted, toPct, priceWithDiscount } = await import('../../src/lib/format.ts');
    expect(discounted(100000, 20)).toBe(80000);
    expect(discounted(99999, 12.5)).toBe(87499);          // 87499.125 → 87499
    expect(discounted(33333, 33.33)).toBe(22223);         // 22222.9 → 22223
    expect(discounted(50000, 100)).toBe(0);
    expect(discounted(50000, 0)).toBe(50000);
    expect(toPct('')).toBe(0);
    expect(toPct('33.33')).toBe(33.33);
    expect(() => toPct('101')).toThrow();
    expect(() => toPct('-1')).toThrow();
    expect(() => toPct('10.555')).toThrow();
    expect(priceWithDiscount(80000, 100000, 20)).toMatch(/was .*1,000.*20% off/);
    expect(priceWithDiscount(0)).toBe('Free');
  });
});
