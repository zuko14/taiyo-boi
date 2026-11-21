import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RpcForm } from '@/components/RpcForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, PageHead } from '@/components/ui';
import { UpiPay } from '@/components/UpiPay';
import { inr } from '@/lib/format';
import { env } from '@/lib/env';
import { LiveRefresh } from '@/components/LiveRefresh';
import { requirePerm } from '@/lib/auth';
import { labelSettings } from '@/lib/label';
import { TagPrinter } from './TagPrinter';

export default async function TagPage({ params }: { params: Promise<{ eventId: string; regId: string }> }) {
  const { eventId, regId } = await params;
  const ctx = await requirePerm(eventId, 'registration.create', 'tag.reprint');
  const { data: reg } = await ctx.supabase.from('registrations').select('id, registration_code, tag_version, tag_printed_confirmed_at, participants(full_name, age), packages(name)')
    .eq('id', regId).eq('event_id', eventId).maybeSingle();
  if (!reg) notFound();
  const p = reg.participants as unknown as { full_name: string; age: number | null };
  // registration staff can read orders (participant.view), not payments; the package order holds the price snapshot
  const { data: dueOrders } = await ctx.supabase.from('orders').select('id, kind, total_paise, order_items(test_name)').eq('registration_id', regId).eq('status', 'active').gt('total_paise', 0).order('created_at');
  const due = (dueOrders ?? []).reduce((n, o) => n + o.total_paise, 0);
  const [{ data: intents }, { data: tasks }, { data: active }] = await Promise.all([
    ctx.can('payment.view') ? ctx.supabase.from('payment_intents').select('id, order_id, status, amount_paise, created_by, receipts(receipt_no)').eq('registration_id', regId)
      : Promise.resolve({ data: null }),
    ctx.supabase.from('participant_tasks').select('status, payment_intent_id, payment_cleared').eq('registration_id', regId),
    ctx.supabase.from('queue_assignments').select('seq, state, station_id, stations(name, code, location, instructions), participant_tasks(service_name)')
      .eq('registration_id', regId).in('state', ['queued', 'called', 'in_service']).maybeSingle(),
  ]);
  type Intent = { id: string; order_id: string; status: string; amount_paise: number; created_by: string | null; receipts: { receipt_no: string } | null };
  const intentOf = (orderId: string) => ((intents ?? []) as unknown as Intent[]).find((i) => i.order_id === orderId);
  // staff without payment access still see whether everything is paid (computed per task, yes/no only)
  const unpaid = (tasks ?? []).some((t) => t.payment_intent_id && !(t as unknown as { payment_cleared: boolean }).payment_cleared && !['cancelled', 'completed'].includes(t.status));
  const waiting = (tasks ?? []).some((t) => t.status === 'waiting_unassigned');
  const st = active?.stations as unknown as { name: string; code: string; location: string; instructions: string } | undefined;
  const staff = active ? ((await ctx.supabase.rpc('station_on_duty', { p_event: eventId })).data as { station_id: string; staff: string }[] | null)?.find((x) => x.station_id === active.station_id)?.staff : undefined;
  const ahead = active?.state === 'queued'
    ? (await ctx.supabase.from('queue_assignments').select('id', { count: 'exact', head: true }).eq('station_id', active.station_id).eq('state', 'queued').lt('seq', active.seq)).count ?? 0 : 0;
  const methods = (ctx.event.settings.payment_methods as string[] | undefined) ?? [];
  const METHOD: Record<string, string> = { cash: 'Cash', upi_manual: 'UPI (QR) — enter UTR' };
  const l = labelSettings(ctx.event.settings);
  const isReprint = reg.tag_version > 0;
  const back = `/e/${eventId}/participants/${regId}/tag`;
  return (
    <>
      <div className="no-print"><PageHead title={`Tag · ${reg.registration_code}`} meta={`${p.full_name} · ${(reg.packages as unknown as { name: string }).name}`}>
        <Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/participants/${regId}`}>Participant</Link>
        <Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/register`}>Next registration</Link>
        <LiveRefresh eventId={eventId} tables={['queue_assignments', 'payment_intents']} url={env().NEXT_PUBLIC_SUPABASE_URL} anonKey={env().NEXT_PUBLIC_SUPABASE_ANON_KEY} pollMs={8000} />
      </PageHead></div>

      <section className="glass next-step no-print" aria-live="polite">
        <div className="eyebrow">Send the participant to</div>
        {active && st ? (<>
          <div className="where">{st.name} <span className="mono small muted">{st.code}</span></div>
          {staff ? <div className="text2" style={{ marginBottom: 6 }}>Staff: <strong>{staff}</strong></div> : null}
          <div className="row"><span className="ticket">#{active.seq}</span>
            <span className="text2">{(active.participant_tasks as unknown as { service_name: string }).service_name} · {active.state === 'called' ? 'called now — go straight there' : active.state === 'in_service' ? 'being served' : ahead ? `${ahead} ahead` : 'next in line'}</span></div>
          {st.location ? <div className="small text2" style={{ marginTop: 6 }}>{st.location}{st.instructions ? ` · ${st.instructions}` : ''}</div> : null}
          <div className="small muted" style={{ marginTop: 6 }}>After each station, the participant scans the tag QR on their phone to see where to go next.</div>
        </>) : unpaid ? (
          <div className="where" style={{ fontSize: '1.15rem' }}>Collect the payment first — the first station appears here automatically once it is confirmed.</div>
        ) : waiting ? (
          <div className="where" style={{ fontSize: '1.15rem' }}>No station is free for this participant yet. They will be called automatically; their tag QR shows it. <Link href={`/e/${eventId}/participants/${regId}`}>See why</Link></div>
        ) : (tasks ?? []).length && (tasks ?? []).every((t) => ['completed', 'skipped', 'cancelled'].includes(t.status)) ? (
          <div className="where" style={{ fontSize: '1.15rem' }}>All tests are done.</div>
        ) : <div className="where" style={{ fontSize: '1.15rem' }}>Walk-in tests only — see the participant&apos;s portal for the centre.</div>}
      </section>
      {due > 0 ? (
        <Card className="no-print" title={unpaid ? `Payment due · ${inr(due)}` : `Paid · ${inr(due)}`}
          sub={unpaid ? 'Ask the patient to scan the QR with any UPI app (or take cash), then confirm it below once the money is received.' : 'Payment confirmed — the tests are in the queue.'}>
          {(dueOrders ?? []).map((o) => { const i = intentOf(o.id); const paid = i ? ['paid', 'waived'].includes(i.status) : !unpaid; return (
            <div key={o.id} style={{ marginTop: 10 }}>
              <div className="row-between"><span className="strong small">{o.kind === 'package' ? `Package · ${(reg.packages as unknown as { name: string }).name}` : `Tests · ${(o.order_items as { test_name: string }[]).map((x) => x.test_name).join(', ')}`} · {inr(o.total_paise)}</span>
                {paid ? <span className="badge green">Paid{i?.receipts?.receipt_no ? ` · ${i.receipts.receipt_no}` : ''}</span> : <span className="badge amber">Pending</span>}</div>
              {!paid ? <UpiPay settings={ctx.event.settings} amountPaise={o.total_paise} reference={reg.registration_code} /> : null}
              {!paid && i && ctx.can('payment.verify') && ['pending', 'requires_review'].includes(i.status) ? (
                <RpcForm eventId={eventId} rpc="verify_payment" back={back} ok="Payment confirmed — first station assigned" hidden={{ p_intent: i.id }} className="row" style={{ marginTop: 10, alignItems: 'flex-end' }}>
                  <div className="field" style={{ marginBottom: 0 }}><label htmlFor={`m-${i.id}`}>Received by</label>
                    <select id={`m-${i.id}`} name="p_method" required>{methods.map((m) => <option key={m} value={m}>{METHOD[m] ?? m}</option>)}</select></div>
                  <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}><label htmlFor={`u-${i.id}`}>UPI reference / UTR (not needed for cash)</label>
                    <input id={`u-${i.id}`} name="p_provider_ref" autoComplete="off" inputMode="numeric" placeholder="12-digit UTR from the patient's success screen" /></div>
                  <input type="hidden" name="amount_rupees" value={(i.amount_paise / 100).toFixed(2)} />
                  <SubmitButton className="btn btn-green">Payment received {inr(i.amount_paise)}</SubmitButton>
                  {ctx.event.settings.payment_maker_checker !== false && i.created_by === ctx.user.id
                    ? <p className="small muted" style={{ flexBasis: '100%', margin: 0 }}>Two-person check is on, so someone other than you must confirm this payment. For a single-desk camp, turn off &ldquo;Order creator cannot verify the same payment&rdquo; in Event &amp; readiness.</p> : null}
                </RpcForm>) : null}
              {!paid && !ctx.can('payment.verify') ? <p className="small muted" style={{ margin: '6px 0 0' }}>A cashier confirms this payment on the Payments screen. To confirm it here, give this desk the Cashier role.</p> : null}
              {paid && i ? <Link className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} href={`/e/${eventId}/receipts/${i.id}`}>Print receipt</Link> : null}
            </div>); })}
        </Card>) : null}
      <Card className="no-print" title={isReprint ? `Tag v${reg.tag_version} already issued` : 'Print or display the participant tag'}
        sub="If printing fails, the registration is safe: display the tag on screen, or reprint with a reason. Check the label before giving it.">
        {isReprint && !ctx.can('tag.reprint') ? <div className="alert alert-warn">A supervisor must reprint this tag.</div> : (
          <TagPrinter eventId={eventId} regId={regId} isReprint={isReprint}
            info={{ code: reg.registration_code, name: p.full_name, age: p.age, pkg: (reg.packages as unknown as { name: string }).name, event: ctx.event.name, showAge: l.showAge, w: l.w, h: l.h }} />
        )}
      </Card>
      {reg.tag_version > 0 ? (
        <Card className="no-print" title="Confirm the tag">
          {reg.tag_printed_confirmed_at ? <div className="alert alert-ok">Tag v{reg.tag_version} confirmed given to the participant.</div> : (
            <RpcForm eventId={eventId} rpc="confirm_tag_printed" back={back} ok="Tag confirmed" hidden={{ p_reg: regId }}>
              <p className="small text2">Confirm the tag shows <strong>{reg.registration_code}</strong> and the right participant has it — printed and attached, or shown on screen and scanned/photographed on their phone.</p>
              <SubmitButton className="btn btn-green">Tag given to participant</SubmitButton>
            </RpcForm>)}
        </Card>) : null}
    </>
  );
}
