'use client';
import { useEffect, useMemo, useRef, useState } from 'react';

/** price_paise null = no active price yet: listed (so the desk can find it) but cannot be sold. */
export interface PickTest { id: string; name: string; code: string; category: string; price_paise: number | null; location: string }

const rupees = (p: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(p / 100);
// "2D Echo", "2d-echo", "2DECHO" and "x ray" / "X-Ray" all match each other
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Paid tests chosen at the registration desk. Tests already in the selected package are disabled.
 * The server recomputes prices and rejects anything invalid; the total here is only a preview.
 */
export function TestPicker({ tests, packageTests, priceHref }: { tests: PickTest[]; packageTests: Record<string, string[]>; priceHref?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cls, setCls] = useState('');
  const inPkg = useMemo(() => new Set(packageTests[cls] ?? []), [packageTests, cls]);
  const sellable = useMemo(() => new Set(tests.filter((t) => t.price_paise != null).map((t) => t.id)), [tests]);
  // a test the chosen package already includes is never sold on top (disabled inputs are not submitted)
  const chosen = useMemo(() => new Set([...picked].filter((id) => !inPkg.has(id) && sellable.has(id))), [picked, inPkg, sellable]);

  useEffect(() => {
    const form = root.current?.closest('form');
    if (!form) return;
    const onChange = (e: Event) => {
      const t = e.target as HTMLInputElement;
      if (t.name === 'classification') setCls(t.value);
    };
    form.addEventListener('change', onChange);
    return () => form.removeEventListener('change', onChange);
  }, []);
  // buying tests needs the participant's confirmation of tests and price
  useEffect(() => {
    const consent = root.current?.closest('form')?.querySelector<HTMLInputElement>('input[name="consent"]');
    if (consent) consent.required = chosen.size > 0 || consent.dataset.required === '1';
  }, [chosen]);

  const nq = norm(q);
  const shown = tests.filter((t) => !nq || norm(`${t.name} ${t.code} ${t.category}`).includes(nq));
  const groups = [...new Set(shown.map((t) => t.category || 'Other'))];
  const total = tests.filter((t) => chosen.has(t.id)).reduce((n, t) => n + (t.price_paise ?? 0), 0);
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const unpriced = tests.filter((t) => t.price_paise == null).length;

  return (
    <div ref={root} className="test-picker">
      <div className="row-between" style={{ marginBottom: 8 }}>
        <span className="label">Tests (paid by the participant)</span>
        <span className="strong" aria-live="polite">{chosen.size} selected · {rupees(total)}</span>
      </div>
      <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${tests.length} tests by name, code or category`} aria-label="Search tests" />
      <div className="test-picker-list">
        {groups.map((g) => (
          <fieldset key={g}>
            <legend className="small muted">{g}</legend>
            {shown.filter((t) => (t.category || 'Other') === g).map((t) => {
              const included = inPkg.has(t.id);
              const noPrice = t.price_paise == null;
              return (
                <label key={t.id} className={`check test-row ${included || noPrice ? 'muted' : ''}`}>
                  <input type="checkbox" name="test_ids" value={t.id} checked={chosen.has(t.id)} disabled={included || noPrice} onChange={() => toggle(t.id)} />
                  <span className="test-name">{t.name}{t.location === 'walk_in' ? <span className="small muted"> · walk-in centre</span> : null}</span>
                  <span className="test-price">{included ? 'in package' : noPrice ? 'no price set' : rupees(t.price_paise!)}</span>
                </label>);
            })}
          </fieldset>))}
        {!shown.length ? <p className="small muted">No test matches “{q}”. Check the Test catalogue — the test may be inactive or archived.</p> : null}
        {/* selections hidden by the search filter must still be submitted */}
        {[...chosen].filter((id) => !shown.some((t) => t.id === id)).map((id) => <input key={id} type="hidden" name="test_ids" value={id} />)}
      </div>
      {unpriced ? <p className="small muted" style={{ margin: '8px 0 0' }}>{unpriced} test{unpriced > 1 ? 's have' : ' has'} no price yet and can only be given inside a package.{priceHref ? <> <a href={priceHref}>Set prices</a></> : ' Ask the event admin to set a price in the Test catalogue.'}</p> : null}
      {chosen.size ? <p className="small text2" style={{ margin: '8px 0 0' }}>Collect {rupees(total)} by UPI QR or cash after registering. The tests are queued once the payment is verified.</p> : null}
    </div>
  );
}
