import { notFound } from 'next/navigation';
import { PrintButton } from '../../tag-test/PrintButton';
import { requirePerm } from '@/lib/auth';
import { dt, inr } from '@/lib/format';

type Snap = { registration_code: string; participant: string; amount_paise: number; method: string; reference: string | null; event: string;
  items: { name: string; unit_price_paise: number; tax_paise: number; quantity: number }[] };

export default async function Receipt({ params }: { params: Promise<{ eventId: string; intentId: string }> }) {
  const { eventId, intentId } = await params;
  const ctx = await requirePerm(eventId, 'payment.view', 'finance.view');
  const { data: r } = await ctx.supabase.from('receipts').select('*').eq('intent_id', intentId).eq('event_id', eventId).maybeSingle();
  if (!r) notFound();
  const s = r.snapshot as Snap;
  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <div className="row-between"><h3>Payment receipt</h3><span className="no-print"><PrintButton /></span></div>
      <dl className="kv" style={{ marginTop: 14 }}>
        <dt>Receipt no.</dt><dd className="mono">{r.receipt_no}</dd><dt>Issued</dt><dd>{dt(r.issued_at, ctx.event.timezone)}</dd>
        <dt>Event</dt><dd>{s.event}</dd><dt>Registration</dt><dd className="mono">{s.registration_code}</dd><dt>Participant</dt><dd>{s.participant}</dd>
        <dt>Method</dt><dd>{s.method}{s.reference ? ` · ref …${s.reference.slice(-4)}` : ''}</dd>
      </dl>
      <ul className="list" style={{ marginTop: 14 }}>{s.items.map((i, k) => <li key={k}><span>{i.name}</span><span>{inr((i.unit_price_paise + i.tax_paise) * i.quantity)}</span></li>)}
        <li><span className="strong">Total paid (add-on tests only)</span><span className="strong">{inr(s.amount_paise)}</span></li></ul>
      <p className="small muted">Sponsored package tests are free of charge to the employee and are not part of this receipt.</p>
    </div>
  );
}
