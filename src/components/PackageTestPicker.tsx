'use client';
import { useMemo, useState } from 'react';

export interface PkgTest { id: string; name: string; category: string; price_paise: number | null; visit: string | null; walkIn: boolean }

const rupees = (p: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(p / 100);

/** Tick the tests a package contains. Submits every chosen id as `test_ids`; the server re-validates. */
export function PackageTestPicker({ tests, initial, noun = 'in this package', allowUnlinked = false }: { tests: PkgTest[]; initial: string[]; noun?: string; allowUnlinked?: boolean }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial));
  const shown = useMemo(() => tests.filter((t) => !q || `${t.name} ${t.category}`.toLowerCase().includes(q.toLowerCase())), [tests, q]);
  const groups = [...new Set(shown.map((t) => t.category || 'Other'))];
  const chosen = tests.filter((t) => picked.has(t.id));
  const worth = chosen.reduce((n, t) => n + (t.price_paise ?? 0), 0);
  const noVisit = chosen.filter((t) => !t.visit);
  const set = (ids: string[], on: boolean) => setPicked((p) => { const n = new Set(p); ids.forEach((id) => (on ? n.add(id) : n.delete(id))); return n; });
  const added = chosen.filter((t) => !initial.includes(t.id)).length;
  const removed = initial.filter((id) => !picked.has(id)).length;

  return (
    <div className="test-picker">
      <div className="row-between" style={{ marginBottom: 8 }}>
        <span className="strong" aria-live="polite">{chosen.length} test{chosen.length === 1 ? '' : 's'} {noun}{worth ? ` · worth ${rupees(worth)} individually` : ''}</span>
        <span className="small muted">{added || removed ? `${added} to add · ${removed} to remove` : 'no changes'}</span>
      </div>
      <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${tests.length} catalogue tests by name or category`} aria-label="Search tests" />
      <div className="test-picker-list">
        {groups.map((g) => {
          const ids = shown.filter((t) => (t.category || 'Other') === g).map((t) => t.id);
          const all = ids.every((id) => picked.has(id));
          return (
            <fieldset key={g}>
              <legend className="small muted row-between" style={{ width: '100%' }}>
                <span>{g}</span>
                <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '2px 10px' }} onClick={() => set(ids, !all)}>{all ? 'Clear' : 'Select all'}</button>
              </legend>
              {shown.filter((t) => (t.category || 'Other') === g).map((t) => (
                <label key={t.id} className="check test-row">
                  <input type="checkbox" name="test_ids" value={t.id} checked={picked.has(t.id)} onChange={(e) => set([t.id], e.target.checked)} />
                  <span className="test-name">{t.name}<span className="small muted"> · {t.visit ?? 'no visit — cannot be queued'}{t.walkIn ? ' · walk-in' : ''}</span></span>
                  <span className="test-price">{t.price_paise != null ? rupees(t.price_paise) : '—'}</span>
                </label>))}
            </fieldset>);
        })}
        {!shown.length ? <p className="small muted">No test matches “{q}”.</p> : null}
        {/* selections hidden by the search filter must still be submitted */}
        {[...picked].filter((id) => !shown.some((t) => t.id === id)).map((id) => <input key={id} type="hidden" name="test_ids" value={id} />)}
      </div>
      {noVisit.length && !allowUnlinked ? <p className="small" style={{ color: 'var(--red)', margin: '8px 0 0' }}>Link these to a visit in the Test catalogue first: {noVisit.map((t) => t.name).join(', ')}</p> : null}
    </div>
  );
}
