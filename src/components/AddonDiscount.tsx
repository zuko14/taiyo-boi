'use client';
import { useState } from 'react';
import { discounted } from '@/lib/format';

export interface AddonLine { id: string; name: string; price_paise: number; tax_paise: number }

const rupees = (p: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(p / 100);
const price = (p: number) => (p === 0 ? 'Free' : rupees(p));

/**
 * Add-on desk confirmation lines with the optional per-patient discount (same fields as the
 * registration desk: disc_<testId> + discount_reason). The database re-checks permission, range,
 * reason and prices; the total here is only a preview.
 */
export function AddonDiscount({ lines, canDiscount }: { lines: AddonLine[]; canDiscount: boolean }) {
  const [disc, setDisc] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const pctOf = (id: string) => { const n = Number(disc[id]); return disc[id] && Number.isFinite(n) && n > 0 && n <= 100 ? n : 0; };
  // the discount is taken off the test price; tax/fee stays as configured
  const finalOf = (l: AddonLine) => discounted(l.price_paise, pctOf(l.id)) + l.tax_paise;
  const total = lines.reduce((n, l) => n + finalOf(l), 0);
  const listTotal = lines.reduce((n, l) => n + l.price_paise + l.tax_paise, 0);
  const paid = lines.filter((l) => l.price_paise > 0);
  const anyDiscount = paid.some((l) => pctOf(l.id) > 0);

  return (
    <>
      <ul className="list">
        {lines.map((l) => (
          <li key={l.id}>
            <span>{l.name}{l.tax_paise ? <span className="small muted"> (incl. {rupees(l.tax_paise)} tax/fee)</span> : null}</span>
            <span className="addon-price">{pctOf(l.id) ? <><s className="muted">{price(l.price_paise + l.tax_paise)}</s> <strong>{price(finalOf(l))}</strong> <span className="badge green">{pctOf(l.id)}% off</span></> : price(l.price_paise + l.tax_paise)}</span>
          </li>))}
        <li><span className="strong">Total payable by participant</span>
          <span className="strong" style={{ fontSize: '1.3rem' }} aria-live="polite">{anyDiscount ? <><s className="muted small">{rupees(listTotal)}</s> </> : null}{rupees(total)}</span></li>
      </ul>
      {canDiscount && paid.length ? (
        <div className="desk-discount">
          <label className="check"><input type="checkbox" checked={open} onChange={(e) => { setOpen(e.target.checked); if (!e.target.checked) setDisc({}); }} />
            <span className="small"><strong>This participant is eligible for a discount</strong></span></label>
          {open ? (<>
            <p className="small muted" style={{ margin: '2px 0 8px' }}>Only for this person. Other participants and the catalogue price are unchanged. Recorded with your name and the reason.</p>
            <ul className="list">{paid.map((l) => (
              <li key={l.id}><span>{l.name} · {rupees(l.price_paise)}{pctOf(l.id) ? <> → <strong>{rupees(discounted(l.price_paise, pctOf(l.id)))}</strong></> : null}</span>
                <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <input className="input" name={`disc_${l.id}`} type="number" min={0} max={100} step="0.01" inputMode="decimal" placeholder="0"
                    aria-label={`Discount percent for ${l.name}`} value={disc[l.id] ?? ''} onChange={(e) => setDisc((d) => ({ ...d, [l.id]: e.target.value }))}
                    style={{ width: 90, padding: '8px 10px' }} />%</span></li>))}
            </ul>
            <div className="field" style={{ marginTop: 8 }}><label htmlFor="discount_reason">Reason for the discount{anyDiscount ? ' (required)' : ''}</label>
              <input id="discount_reason" name="discount_reason" maxLength={200} required={anyDiscount} placeholder="e.g. Senior citizen, staff family, camp organiser offer" /></div>
          </>) : null}
        </div>) : null}
      {total === 0 ? <p className="small text2" style={{ margin: '8px 0 0' }}>Nothing to pay — the test{lines.length > 1 ? 's are' : ' is'} queued right away.</p> : null}
    </>
  );
}
