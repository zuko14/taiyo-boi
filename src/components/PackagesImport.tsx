'use client';
import { useState } from 'react';
import { mapPackages, parseCsv, type PackageRow } from '@/lib/catalog-import';
import { SubmitButton } from './SubmitButton';

/** Upload a package CSV, preview each package and its tests, then import (server re-validates). */
export function PackagesImport({ action, eventId, back, live, existing }:
  { action: (fd: FormData) => Promise<void>; eventId: string; back: string; live: boolean; existing: string[] }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ rows: PackageRow[]; errors: { line: number; message: string }[] } | null>(null);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.csv$/i.test(f.name)) { setResult({ rows: [], errors: [{ line: 0, message: 'Choose a .csv file. In Excel: File → Save As → CSV UTF-8.' }] }); return; }
    if (f.size > 2_000_000) { setResult({ rows: [], errors: [{ line: 0, message: 'File is larger than 2 MB.' }] }); return; }
    const t = await f.text(); setText(t); setResult(mapPackages(parseCsv(t)));
  };
  const pkgs = [...new Set((result?.rows ?? []).map((r) => r.package_code))].map((code) => {
    const rows = (result?.rows ?? []).filter((r) => r.package_code === code);
    return { code, name: rows.find((r) => r.package_name)?.package_name ?? '', price: rows.find((r) => r.price_paise != null)?.price_paise ?? null,
      tests: [...new Set(rows.map((r) => r.test).filter(Boolean))], isNew: !existing.includes(code) };
  });
  return (
    <form action={action}>
      <input type="hidden" name="event_id" value={eventId} /><input type="hidden" name="back" value={back} /><input type="hidden" name="csv" value={text} />
      <div className="field"><label htmlFor="pkg-file">CSV file</label><input id="pkg-file" type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} /></div>
      {result ? (<>
        <div className={`alert ${result.errors.length ? 'alert-err' : 'alert-ok'}`} role="status">
          {pkgs.length} package{pkgs.length === 1 ? '' : 's'} ({pkgs.filter((p) => p.isNew).length} new){result.errors.length ? ` — ${result.errors.length} row(s) need fixing first.` : '. Ready to import. Each package will contain exactly the tests listed.'}
        </div>
        {result.errors.length ? <ul className="list small">{result.errors.slice(0, 20).map((e, i) => <li key={i}><span>Line {e.line}: {e.message}</span></li>)}</ul> : null}
        {pkgs.length ? <div className="table-wrap" style={{ maxHeight: 300, overflow: 'auto', marginTop: 10 }}><table>
          <thead><tr><th>Package</th><th>Price</th><th>Tests</th><th></th></tr></thead>
          <tbody>{pkgs.map((p) => (
            <tr key={p.code}><td><span className="strong">{p.name || p.code}</span><div className="mono small muted">{p.code}</div></td>
              <td>{p.price != null ? `₹${(p.price / 100).toLocaleString('en-IN')}` : <span className="muted">unchanged</span>}</td>
              <td className="wrap small">{p.tests.length} · {p.tests.join(', ')}</td>
              <td>{p.isNew ? <span className="badge green">new</span> : <span className="badge plain">update</span>}</td></tr>))}</tbody></table></div> : null}
        {live ? <input className="input" name="reason" required placeholder="Reason for changing live configuration" aria-label="Change reason" style={{ marginTop: 8 }} /> : null}
        <div className="row" style={{ marginTop: 10 }}>
          <SubmitButton className="btn btn-solid" disabled={!!result.errors.length || !pkgs.length}
            confirm={`Import ${pkgs.length} package(s)? Each package's test list is replaced by the file. Existing registrations keep theirs.`}>Import {pkgs.length} package{pkgs.length === 1 ? '' : 's'}</SubmitButton>
        </div>
      </>) : null}
    </form>
  );
}
