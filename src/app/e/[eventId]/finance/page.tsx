import { Card, PageHead, Stat } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { inr } from '@/lib/format';

type Rev = { by_test: { code: string; name: string; quantity: number; unit_prices: number[]; gross_paise: number; tax_paise: number; paid_paise: number | null; pending_paise: number | null; failed_paise: number | null; waived_paise: number | null }[];
  totals: { verified_received_paise: number; refunded_paise: number; pending_paise: number; failed_paise: number; waived_paise: number };
  by_method: { method: string; count: number; amount_paise: number }[]; by_cashier: { name: string; count: number; amount_paise: number }[] };

export default async function Finance({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await requirePerm(eventId, 'finance.view');
  const { data } = await ctx.supabase.rpc('addon_revenue', { p_event: eventId });
  const r = data as Rev;
  const t = r.totals;
  return (
    <>
      <PageHead title="Add-on revenue" meta="Employee-paid add-ons only. Revenue counts verified payments, not orders. Sponsored packages are reconciled separately (counts only)." />
      <div className="stats">
        <Stat label="Verified received" value={inr(t.verified_received_paise)} />
        <Stat label="Refunded" value={inr(t.refunded_paise)} />
        <Stat label="Net received" value={inr(t.verified_received_paise - t.refunded_paise)} />
        <Stat label="Pending / review" value={inr(t.pending_paise)} tone={t.pending_paise ? 'warn' : undefined} />
        <Stat label="Failed" value={inr(t.failed_paise)} />
        <Stat label="Waived" value={inr(t.waived_paise)} />
      </div>
      <Card title="By test">
        <div className="table-wrap"><table><thead><tr><th>Test</th><th>Qty</th><th>Unit price(s)</th><th>Gross</th><th>Tax/fee</th><th>Paid</th><th>Pending</th><th>Failed</th><th>Waived</th></tr></thead>
          <tbody>{r.by_test.map((x) => (
            <tr key={x.code}><td className="strong">{x.name}</td><td>{x.quantity}</td><td>{x.unit_prices.map((p) => inr(p)).join(', ')}</td><td>{inr(x.gross_paise)}</td><td>{inr(x.tax_paise)}</td>
              <td>{inr(x.paid_paise ?? 0)}</td><td>{inr(x.pending_paise ?? 0)}</td><td>{inr(x.failed_paise ?? 0)}</td><td>{inr(x.waived_paise ?? 0)}</td></tr>))}</tbody></table></div>
        <p className="small muted" style={{ marginTop: 10 }}>“Paid” is the order value of verified payments; refunds are reported at payment level above.</p>
      </Card>
      <div className="grid grid-2">
        <Card title="By payment method"><ul className="list">{r.by_method.map((m) => <li key={m.method}><span>{m.method} · {m.count}</span><span className="strong">{inr(m.amount_paise)}</span></li>)}{!r.by_method.length ? <li className="muted">None yet</li> : null}</ul></Card>
        <Card title="By cashier"><ul className="list">{r.by_cashier.map((m) => <li key={m.name}><span>{m.name} · {m.count}</span><span className="strong">{inr(m.amount_paise)}</span></li>)}{!r.by_cashier.length ? <li className="muted">None yet</li> : null}</ul></Card>
      </div>
    </>
  );
}
