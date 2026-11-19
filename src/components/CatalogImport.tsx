'use client';
import { useState } from 'react';
import { mapCatalog, parseCsv, type ImportRow } from '@/lib/catalog-import';
import { SubmitButton } from './SubmitButton';

/** Upload a catalogue CSV, preview what will be created/updated, then import (server re-validates). */
export function CatalogImport({ action, eventId, back, live, existing }:
  { action: (fd: FormData) => Promise<void>; eventId: string; back: string; live: boolean; existing: string[] }) {
  const [text, setText] = useState('');
  const [file, setFile] = useState('');
  const [result, setResult] = useState<{ rows: ImportRow[]; errors: { line: number; message: string }[] } | null>(null);
  const known = new Set(existing);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.csv$/i.test(f.name)) { setResult({ rows: [], errors: [{ line: 0, message: 'Choose a .csv file. In Excel: File → Save As → CSV UTF-8.' }] }); return; }
    if (f.size > 2_000_000) { setResult({ rows: [], errors: [{ line: 0, message: 'File is larger than 2 MB.' }] }); return; }
    const t = await f.text();
    setFile(f.name); setText(t); setResult(mapCatalog(parseCsv(t)));
  };
  const rupees = (p: number | null) => (p == null ? '—' : `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);
  const fresh = result?.rows.filter((r) => !known.has(r.code)).length ?? 0;
  return (
    <form action={action}>
      <input type="hidden" name="event_id" value={eventId} /><input type="hidden" name="back" value={back} />
      <input type="hidden" name="csv" value={text} />
      <div className="field"><label htmlFor="cat-file">CSV file</label>
        <input id="cat-file" type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} /></div>
      {result ? (
        <>
          <div className={`alert ${result.errors.length ? 'alert-err' : 'alert-ok'}`} role="status">
            {file}: {result.rows.length} test{result.rows.length === 1 ? '' : 's'} — {fresh} new, {result.rows.length - fresh} existing (updated by code)
            {result.errors.length ? `; ${result.errors.length} row(s) need fixing before import.` : '. Ready to import.'}
          </div>
          {result.errors.length ? <ul className="list small">{result.errors.slice(0, 20).map((e, i) => <li key={i}><span>Line {e.line}: {e.message}</span></li>)}</ul> : null}
          {result.rows.length ? (
            <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto', marginTop: 10 }}><table>
              <thead><tr><th>Code</th><th>Name</th><th>Category</th><th>Price</th><th>Where</th><th>Service</th><th></th></tr></thead>
              <tbody>{result.rows.slice(0, 300).map((r) => (
                <tr key={r.code}><td className="mono">{r.code}</td><td>{r.name}</td><td className="small">{r.category}</td><td>{rupees(r.price_paise)}</td>
                  <td className="small">{r.location === 'walk_in' ? 'Walk-in' : 'Event day'}</td><td className="mono small">{r.service_code ?? (r.location === 'walk_in' ? 'WALKIN' : 'SAMPLE')}</td>
                  <td>{known.has(r.code) ? <span className="badge plain">update</span> : <span className="badge green">new</span>}</td></tr>))}</tbody></table></div>) : null}
          {live ? <input className="input" name="reason" required placeholder="Reason for changing live configuration" aria-label="Change reason" style={{ marginTop: 8 }} /> : null}
          <div className="row" style={{ marginTop: 10 }}>
            <SubmitButton className="btn btn-solid" disabled={!!result.errors.length || !result.rows.length}
              confirm={`Import ${result.rows.length} tests? Existing codes are updated; prices change for new orders only.`}>Import {result.rows.length} tests</SubmitButton>
          </div>
        </>) : null}
    </form>
  );
}
