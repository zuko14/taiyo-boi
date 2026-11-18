import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RpcForm } from '@/components/RpcForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, PageHead } from '@/components/ui';
import { UpiPay } from '@/components/UpiPay';
import { inr } from '@/lib/format';
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
  const { data: pkgOrder } = await ctx.supabase.from('orders').select('total_paise').eq('registration_id', regId).eq('kind', 'package').eq('status', 'active').maybeSingle();
  const due = pkgOrder?.total_paise ?? 0;
  const l = labelSettings(ctx.event.settings);
  const isReprint = reg.tag_version > 0;
  const back = `/e/${eventId}/participants/${regId}/tag`;
  return (
    <>
      <div className="no-print"><PageHead title={`Tag · ${reg.registration_code}`} meta={`${p.full_name} · ${(reg.packages as unknown as { name: string }).name}`}>
        <Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/participants/${regId}`}>Participant</Link>
        <Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/register`}>Next registration</Link>
      </PageHead></div>
      {due > 0 ? (
        <Card className="no-print" title={`Package payment due · ${inr(due)}`} sub="Collect by the lab's UPI QR or cash. The participant's tests are queued once a cashier verifies the payment on the Payments page.">
          <UpiPay settings={ctx.event.settings} amountPaise={due} reference={reg.registration_code} />
        </Card>) : null}
      <Card className="no-print" title={isReprint ? `Tag v${reg.tag_version} already issued` : 'Print the participant tag'}
        sub="If printing fails, the registration is safe: reprint with a reason. Check the label before attaching it.">
        {isReprint && !ctx.can('tag.reprint') ? <div className="alert alert-warn">A supervisor must reprint this tag.</div> : (
          <TagPrinter eventId={eventId} regId={regId} isReprint={isReprint}
            info={{ code: reg.registration_code, name: p.full_name, age: p.age, pkg: (reg.packages as unknown as { name: string }).name, event: ctx.event.name, showAge: l.showAge, w: l.w, h: l.h }} />
        )}
      </Card>
      {reg.tag_version > 0 ? (
        <Card className="no-print" title="Confirm the tag">
          {reg.tag_printed_confirmed_at ? <div className="alert alert-ok">Tag v{reg.tag_version} confirmed printed and attached.</div> : (
            <RpcForm eventId={eventId} rpc="confirm_tag_printed" back={back} ok="Tag confirmed" hidden={{ p_reg: regId }}>
              <p className="small text2">Confirm the printed tag shows <strong>{reg.registration_code}</strong> and is attached to the right participant.</p>
              <SubmitButton className="btn btn-green">Printed and attached</SubmitButton>
            </RpcForm>)}
        </Card>) : null}
    </>
  );
}
