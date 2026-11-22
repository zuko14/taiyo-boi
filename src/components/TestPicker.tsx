'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { discounted } from '@/lib/format';

/** price_paise null = no active price yet: listed (so the desk can find it) but cannot be sold. */
export interface PickTest { id: string; name: string; code: string; category: string; price_paise: number | null; location: string; mrp_paise?: number | null; discount_pct?: number }

const rupees = (p: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(p / 100);
const price = (p: number) => (p === 0 ? 'Free' : rupees(p));
// "2D Echo", "2d-echo", "2DECHO" and "x ray" / "X-Ray" all match each other
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Paid tests chosen at the registration desk. Tests already in the selected package are disabled.
 * The server recomputes prices and rejects anything invalid; the total here is only a preview.
 */
export function TestPicker({ tests, packageTests, priceHref, canDiscount = false, packagePrices = {} }:
  { tests: PickTest[]; packageTests: Record<string, string[]>; priceHref?: string; canDiscount?: boolean; packagePrices?: Record<string, number> }) {
  const [disc, setDisc] = useState<Record<string, string>>({});
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
  // per-patient desk discount ("" = none); the server re-checks permission, range and reason
  const pctOf = (k: string) => { const n = Number(disc[k]); return disc[k] && Number.isFinite(n) && n > 0 && n <= 100 ? n : 0; };
  const finalOf = (t: PickTest) => discounted(t.price_paise ?? 0, pctOf(t.id));
  const total = tests.filter((t) => chosen.has(t.id)).reduce((n, t) => n + finalOf(t), 0);
  const pkgPrice = packagePrices[cls] ?? 0;
  const pkgFinal = discounted(pkgPrice, pctOf('pkg'));
  const anyDiscount = [...chosen].some((id) => pctOf(id) > 0) || (pkgPrice > 0 && pctOf('pkg') > 0);
  const paidChosen = tests.filter((t) => chosen.has(t.id) && (t.price_paise ?? 0) > 0);
  const pctInput = (k: string, name: string, label: string) => (
    <input className="input" name={name} type="number" min={0} max={100} step="0.01" inputMode="decimal" placeholder="0" aria-label={label}
      value={disc[k] ?? ''} onChange={(e) => setDisc((d) => ({ ...d, [k]: e.target.value }))} style={{ width: 90, padding: '6px 10px' }} />);
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const unpriced = tests.filter((t) => t.price_paise == null).length;

  return (
    <div ref={root} className="test-picker">
      {tests.length ? (<>
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
                  <span className="test-price">{included ? 'in package' : noPrice ? 'no price set' : t.discount_pct && t.mrp_paise != null
                    ? <><s className="muted">{rupees(t.mrp_paise)}</s> {price(t.price_paise!)} <span className="badge green">{t.discount_pct}% off</span></> : price(t.price_paise!)}</span>
                </label>);
            })}
          </fieldset>))}
        {!shown.length ? <p className="small muted">No test matches “{q}”. Check the Test catalogue — the test may be inactive or archived.</p> : null}
        {/* selections hidden by the search filter must still be submitted */}
        {[...chosen].filter((id) => !shown.some((t) => t.id === id)).map((id) => <input key={id} type="hidden" name="test_ids" value={id} />)}
      </div>
      </>) : null}
      {unpriced ? <p className="small muted" style={{ margin: '8px 0 0' }}>{unpriced} test{unpriced > 1 ? 's have' : ' has'} no price yet and can only be given inside a package.{priceHref ? <> <a href={priceHref}>Set prices</a></> : ' Ask the event admin to set a price in the Test catalogue.'}</p> : null}
      {canDiscount && (paidChosen.length || pkgPrice > 0) ? (
        <div className="desk-discount" style={{ marginTop: 12 }}>
          <div className="label">Discount for this patient only (optional)</div>
          <p className="small muted" style={{ margin: '2px 0 8px' }}>Only if this person is eligible. Other patients keep the normal price. Recorded with your name and the reason.</p>
          <ul className="list">
            {pkgPrice > 0 ? (
              <li><span>Package · {rupees(pkgPrice)}{pctOf('pkg') ? <> → <strong>{rupees(pkgFinal)}</strong></> : null}</span>
                <span className="row" style={{ gap: 6 }}>{pctInput('pkg', 'package_discount_pct', 'Package discount percent')}%</span></li>) : null}
            {paidChosen.map((t) => (
              <li key={t.id}><span>{t.name} · {rupees(t.price_paise!)}{pctOf(t.id) ? <> → <strong>{rupees(finalOf(t))}</strong></> : null}</span>
                <span className="row" style={{ gap: 6 }}>{pctInput(t.id, `disc_${t.id}`, `Discount percent for ${t.name}`)}%</span></li>))}
          </ul>
          <div className="field" style={{ marginTop: 8 }}><label htmlFor="discount_reason">Reason for the discount{anyDiscount ? ' (required)' : ''}</label>
            <input id="discount_reason" name="discount_reason" maxLength={200} required={anyDiscount} placeholder="e.g. Senior citizen, staff family, camp organiser offer" /></div>
          <div className="row-between strong"><span>Total to collect</span><span aria-live="polite">{rupees(pkgFinal + total)}</span></div>
        </div>) : null}
      {chosen.size ? <p className="small text2" style={{ margin: '8px 0 0' }}>{pkgFinal + total > 0
        ? `Collect ${rupees(pkgFinal + total)} by UPI QR or cash after registering. Paid tests are queued once the payment is verified${tests.some((t) => chosen.has(t.id) && t.price_paise === 0) ? '; free tests are queued right away' : ''}.`
        : 'Free tests — no payment is taken. They are queued right after registration.'}</p> : null}
    </div>
  );
}
