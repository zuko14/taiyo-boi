// Catalogue CSV import: parsing and column mapping. Pure functions, shared by the browser preview
// and the server action (which re-parses the raw text; the browser result is never trusted).

/** RFC 4180 parser: quoted fields, "" escapes, CRLF/LF, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export interface ImportRow {
  line: number; code: string; name: string; category: string; price_paise: number | null;
  location: 'event_day' | 'walk_in'; service_code: string | null; lab_order_code: string; instructions: string;
}

export const TEMPLATE_COLUMNS = ['code', 'name', 'category', 'price_inr', 'location', 'service', 'lab_order_code', 'instructions'] as const;

// header aliases, including the lab's "2025 Verified MRP" sheet (S. No / Category / Test Description / MRP (INR))
const ALIAS: Record<string, (typeof TEMPLATE_COLUMNS)[number]> = {
  code: 'code', test_code: 'code',
  name: 'name', test_name: 'name', test_description: 'name', test: 'name', description: 'name',
  category: 'category', test_category: 'category', speciality: 'category',
  price_inr: 'price_inr', price: 'price_inr', mrp: 'price_inr', mrp_inr: 'price_inr', mrp_rs: 'price_inr', rate: 'price_inr',
  location: 'location', performed_at: 'location',
  service: 'service', service_code: 'service', visit: 'service',
  lab_order_code: 'lab_order_code', order_code: 'lab_order_code',
  instructions: 'instructions',
};
const key = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
// toCsv() prefixes ' to cells starting with = + - @ (formula-injection guard); undo it on re-import
const clean = (v: string | undefined) => (v ?? '').trim().replace(/^'(?=[=+\-@])/, '');

/** "₹1,200", "1200.50", "1 200" → paise. Blank → null. */
export function priceToPaise(v: string): number | null | 'invalid' {
  const t = v.replace(/[₹,\s]|rs\.?|inr/gi, '');
  if (!t) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return 'invalid';
  return Math.round(Number(t) * 100);
}

/** Stable code from a test name when the sheet has no code column. */
export const codeFromName = (name: string) =>
  name.toUpperCase().replace(/\(.*?\)/g, ' ').replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'TEST';

export function mapCatalog(rows: string[][]): { rows: ImportRow[]; errors: { line: number; message: string }[] } {
  const errors: { line: number; message: string }[] = [];
  // header = first row that names a test column (title rows above it are skipped)
  const h = rows.findIndex((r) => r.some((c) => ALIAS[key(c)] === 'name'));
  if (h < 0) return { rows: [], errors: [{ line: 1, message: 'No header row found. Use the template: code, name, category, price_inr, location, service.' }] };
  const col = new Map<string, number>();
  rows[h].forEach((c, i) => { const k = ALIAS[key(c)]; if (k && !col.has(k)) col.set(k, i); });
  const get = (r: string[], k: string) => (col.has(k) ? clean(r[col.get(k)!]) : '');

  const out: ImportRow[] = []; const seen = new Map<string, number>();
  rows.slice(h + 1).forEach((r, i) => {
    const line = h + i + 2;
    const name = get(r, 'name');
    if (!name) return;                                      // blank, subtotal and section rows
    let code = get(r, 'code').toUpperCase();
    if (!code) {                                          // generated codes stay unique within the file
      const base = codeFromName(name); let c = base; let n = 2;
      while (seen.has(c)) c = `${base.slice(0, 37)}-${n++}`;
      code = c;
    }
    if (!/^[A-Z0-9_-]{1,40}$/.test(code)) { errors.push({ line, message: `Invalid code "${code}" (A–Z, 0–9, _ and -, max 40)` }); return; }
    if (seen.has(code)) { errors.push({ line, message: `Duplicate code ${code} (also on line ${seen.get(code)})` }); return; }
    const price = priceToPaise(get(r, 'price_inr'));
    if (price === 'invalid') { errors.push({ line, message: `Price "${get(r, 'price_inr')}" is not a number` }); return; }
    const locRaw = key(get(r, 'location'));
    const location = !locRaw || ['event_day', 'event', 'camp', 'onsite', 'on_site'].includes(locRaw) ? 'event_day'
      : ['walk_in', 'walkin', 'centre', 'center', 'walk_in_centre'].includes(locRaw) ? 'walk_in' : null;
    if (!location) { errors.push({ line, message: `Location "${get(r, 'location')}" must be event_day or walk_in` }); return; }
    const service = get(r, 'service').toUpperCase().replace(/[^A-Z0-9_-]+/g, '_') || null;
    seen.set(code, line);
    out.push({ line, code, name: name.slice(0, 200), category: get(r, 'category').slice(0, 100), price_paise: price, location,
      service_code: service, lab_order_code: get(r, 'lab_order_code').slice(0, 60), instructions: get(r, 'instructions').slice(0, 500) });
  });
  if (!out.length && !errors.length) errors.push({ line: h + 1, message: 'The file has a header but no test rows.' });
  return { rows: out, errors };
}
