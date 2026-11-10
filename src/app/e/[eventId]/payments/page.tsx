import Link from 'next/link';
import { ReasonAction, RpcForm } from '@/components/RpcForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, Empty, PageHead, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { dt, inr } from '@/lib/format';

const METHOD_LABEL: Record<string, string> = { cash: 'Cash', upi_manual: 'UPI (manual check of settlement/UTR)' };

export default async function Payments({ params, searchParams }: { params: Promise<{ eventId: string }>; searchParams: Promise<{ intent?: string; show?: string }> }) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm(eventId, 'payment.verify', 'payment.view');
  const tz = ctx.event.timezone;
  const base = `/e/${eventId}/payments`;
  const methods = (ctx.event.settings.payment_methods as string[] | undefined) ?? [];
  const states = sp.show === 'all' ? ['pending', 'requires_review', 'paid', 'failed', 'cancelled', 'refunded', 'partially_refunded', 'waived'] : ['pending', 'requires_review'];

  const { data: intents } = await ctx.supabase.from('payment_intents')
    .select('*, registrations(registration_code, participants(full_name)), receipts(receipt_no)')
    .eq('event_id', eventId).in('status', states).order('created_at', { ascending: sp.show !== 'all' }).limit(200);
  const sel = sp.intent ? (await ctx.supabase.from('payment_intents')
    .select('*, registrations(id, registration_code, participants(full_name)), receipts(receipt_no), orders(order_items(test_name, unit_price_paise, tax_paise, quantity))')
    .eq('id', sp.intent).maybeSingle()).data : null;
  const txns = sel ? (await ctx.supabase.from('payment_transactions').select('*').eq('intent_id', sel.id).order('created_at')).data ?? [] : [];
  const refunds = sel ? (await ctx.supabase.from('refunds').select('*').eq('intent_id', sel.id).order('created_at')).data ?? [] : [];
  const back = sel ? `${base}?intent=${sel.id}` : base;
  type Reg = { id?: string; registration_code: string; participants: { full_name: string } };

  return (
    <>
      <PageHead title="Payments" meta="Verify add-on payments using provider/settlement evidence. A displayed QR or a screenshot is not proof of payment.">
        <div className="toggle-group"><Link className={`toggle-btn ${sp.show !== 'all' ? 'on' : ''}`} href={base}>Needs action</Link><Link className={`toggle-btn ${sp.show === 'all' ? 'on' : ''}`} href={`${base}?show=all`}>All</Link></div>
      </PageHead>
      {!methods.length ? <div className="alert alert-warn">No payment methods are configured for this event (Event settings → payment methods). Verification is blocked.</div> : null}
      <div className="grid grid-2">
        <Card title={sp.show === 'all' ? 'All add-on payments' : 'Awaiting verification'}>
          {intents?.length ? (
            <div className="table-wrap"><table><thead><tr><th>Participant</th><th>Amount</th><th>Status</th><th>Created</th></tr></thead>
              <tbody>{intents.map((i) => { const r = i.registrations as unknown as Reg; return (
                <tr key={i.id} className={sel?.id === i.id ? 'selected' : ''}>
                  <td><Link href={`${base}?intent=${i.id}${sp.show ? '&show=all' : ''}`} className="strong mono">{r.registration_code}</Link><div className="small muted">{r.participants.full_name}</div></td>
                  <td>{inr(i.amount_paise)}</td><td><StatusBadge status={i.status} /></td><td>{dt(i.created_at, tz)}</td></tr>); })}</tbody></table></div>
          ) : <Empty>Nothing waiting.</Empty>}
        </Card>
        <Card title={sel ? `${(sel.registrations as unknown as Reg).registration_code} · ${inr(sel.amount_paise)}` : 'Select a payment'} sub={sel ? (sel.registrations as unknown as Reg).participants.full_name : undefined}
          actions={sel ? <StatusBadge status={sel.status} /> : null}>
          {sel ? (
            <>
              <ul className="list">{(sel.orders as unknown as { order_items: { test_name: string; unit_price_paise: number; tax_paise: number; quantity: number }[] }).order_items.map((o, k) => (
                <li key={k}><span>{o.test_name}</span><span>{inr((o.unit_price_paise + o.tax_paise) * o.quantity)}</span></li>))}</ul>
              {sel.status_reason ? <div className="alert alert-warn" style={{ marginTop: 10 }}>{sel.status_reason}</div> : null}
              {ctx.can('payment.verify') && ['pending', 'requires_review'].includes(sel.status) ? (
                <RpcForm eventId={eventId} rpc="verify_payment" back={back} hidden={{ p_intent: sel.id }} style={{ marginTop: 14 }}>
                  <div className="form-row">
                    <div className="field"><label htmlFor="m">Method</label><select id="m" name="p_method" required>{methods.map((m) => <option key={m} value={m}>{METHOD_LABEL[m] ?? m}</option>)}</select></div>
                    <div className="field"><label htmlFor="a">Amount received (₹)</label><input id="a" name="amount_rupees" inputMode="decimal" required defaultValue={(sel.amount_paise / 100).toFixed(2)} /></div>
                  </div>
                  <div className="field"><label htmlFor="ref">Transaction reference / UTR</label><input id="ref" name="p_provider_ref" placeholder="Required except for cash" autoComplete="off" />
                    <span className="help">Never ask for or record UPI PINs, card numbers or passwords.</span></div>
                  <div className="field"><label htmlFor="n">Note</label><input id="n" name="p_note" /></div>
                  <SubmitButton className="btn btn-accent">Verify payment</SubmitButton>
                </RpcForm>) : null}
              <div className="stack" style={{ marginTop: 14 }}>
                {ctx.can('payment.verify') && ['pending', 'requires_review'].includes(sel.status) ? <ReasonAction eventId={eventId} rpc="payment_action" back={back} hidden={{ p_intent: sel.id, p_action: 'fail' }} label="Mark failed" danger /> : null}
                {ctx.can('payment.verify') && ['failed', 'requires_review'].includes(sel.status) ? <ReasonAction eventId={eventId} rpc="payment_action" back={back} hidden={{ p_intent: sel.id, p_action: 'reopen' }} label="Reopen" /> : null}
                {ctx.can('payment.waive') && ['pending', 'requires_review', 'failed'].includes(sel.status) ? <ReasonAction eventId={eventId} rpc="payment_action" back={back} hidden={{ p_intent: sel.id, p_action: 'waive' }} label="Waive (approved)" /> : null}
                {ctx.can('addon.create') && ['pending', 'failed', 'requires_review'].includes(sel.status) ? <ReasonAction eventId={eventId} rpc="payment_action" back={back} hidden={{ p_intent: sel.id, p_action: 'cancel' }} label="Cancel order" danger /> : null}
                {ctx.can('payment.refund') && ['paid', 'partially_refunded'].includes(sel.status) ? (
                  <RpcForm eventId={eventId} rpc="payment_action" back={back} hidden={{ p_intent: sel.id, p_action: 'refund' }} className="row">
                    <input className="input" name="amount_rupees" inputMode="decimal" required placeholder="₹ amount" style={{ width: 110, padding: '7px 12px' }} aria-label="Refund amount" />
                    <input className="input" name="p_reason" required placeholder="Refund reason" style={{ flex: 1, padding: '7px 12px' }} aria-label="Refund reason" />
                    <input className="input" name="p_provider_ref" placeholder="Refund ref" style={{ width: 120, padding: '7px 12px' }} aria-label="Refund reference" />
                    <SubmitButton className="btn btn-red btn-sm" confirm="Record this refund?">Refund</SubmitButton>
                  </RpcForm>) : null}
              </div>
              {txns.length || refunds.length ? (<><div className="hr" /><div className="label">History</div><ul className="list">
                {txns.map((t) => <li key={t.id}><span className="small">{t.method} {t.provider_ref ? `· ${t.provider_ref.replace(/.(?=.{4})/g, '•')}` : ''} · {inr(t.amount_paise)}{t.note ? ` · ${t.note}` : ''}</span><span className="row"><StatusBadge status={t.status === 'verified' ? 'paid' : 'failed'} label={t.status} /><span className="small muted">{dt(t.created_at, tz, false)}</span></span></li>)}
                {refunds.map((r) => <li key={r.id}><span className="small">Refund {inr(r.amount_paise)} · {r.reason}</span><span className="small muted">{dt(r.created_at, tz, false)}</span></li>)}
              </ul></>) : null}
              {(sel.receipts as { receipt_no: string } | null)?.receipt_no ? <Link className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} href={`/e/${eventId}/receipts/${sel.id}`}>Receipt {(sel.receipts as { receipt_no: string }).receipt_no}</Link> : null}
            </>
          ) : <Empty>Choose a payment from the list.</Empty>}
        </Card>
      </div>
    </>
  );
}
