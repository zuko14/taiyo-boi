import Link from 'next/link';
import { DutyPicker } from '@/components/DutyPicker';
import { ScanBox } from '@/components/ScanBox';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, Empty, PageHead, SourceTag, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { nowMs } from '@/lib/clock';
import { myStations } from '@/lib/duty';
import { classLabel, inr, locationLabel } from '@/lib/format';
import { ScanMatches } from '@/components/ScanMatches';
import { resolveScan, searchRegistrations } from '@/lib/scan';
import { idemKey } from '@/lib/supabase/server';
import { createAddonOrder } from './actions';

type SP = Promise<{ at?: string; scan?: string; reg?: string; review?: string; t?: string | string[]; order?: string }>;

export default async function AddonDesk({ params, searchParams }: { params: Promise<{ eventId: string }>; searchParams: SP }) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm(eventId, 'addon.create');
  const { stations } = await myStations(ctx, ['addon_desk']);
  const desk = sp.at ?? (stations.length === 1 ? stations[0].id : undefined);
  const base = `/e/${eventId}/addons`;
  const regId = sp.reg ?? (await resolveScan(ctx, sp.scan, desk));

  let body = null;
  if (desk && regId) {
    const { data: reg } = await ctx.supabase.from('registrations')
      .select('id, registration_code, classification, status, participants(full_name), packages(name), package_configuration_versions(snapshot)').eq('id', regId).maybeSingle();
    if (!reg) body = <Card><Empty>Registration not found.</Empty></Card>;
    else {
      const snap = (reg.package_configuration_versions as unknown as { snapshot: { tests: { test_id: string; name: string; location: string; choice_group_id: string | null }[] } }).snapshot;
      const inPkg = new Set(snap.tests.map((t) => t.test_id));
      const [{ data: catalog }, { data: prices }, { data: existing }, { data: intents }] = await Promise.all([
        ctx.supabase.from('test_catalog').select('id, code, display_name, location, instructions').eq('event_id', eventId).eq('active', true).eq('archived', false).eq('addon_available', true).order('display_name'),
        ctx.supabase.from('addon_prices').select('test_id, price_paise, tax_paise, location_scope, effective_from, effective_to').eq('event_id', eventId).eq('active', true),
        ctx.supabase.from('order_items').select('test_id, status, orders!inner(status)').eq('registration_id', regId).eq('source', 'addon').eq('status', 'active'),
        ctx.supabase.from('payment_intents').select('id, amount_paise, status, order_id, created_at').eq('registration_id', regId).order('created_at', { ascending: false }),
      ]);
      const now = nowMs();
      const priceOf = (testId: string, loc: string) => (prices ?? []).filter((p) => p.test_id === testId && (p.location_scope === 'both' || p.location_scope === loc)
        && new Date(p.effective_from).getTime() <= now && (!p.effective_to || new Date(p.effective_to).getTime() > now))
        .sort((a, b) => +new Date(b.effective_from) - +new Date(a.effective_from))[0];
      const ordered = new Set((existing ?? []).map((e) => e.test_id));
      const coveredByPackage = (catalog ?? []).filter((t) => inPkg.has(t.id));
      const offer = (catalog ?? []).filter((t) => !inPkg.has(t.id) && !ordered.has(t.id)).map((t) => ({ ...t, price: priceOf(t.id, t.location) }));
      const selected = ([] as string[]).concat(sp.t ?? []).filter((id) => offer.some((o) => o.id === id && o.price));
      const total = selected.reduce((n, id) => { const o = offer.find((x) => x.id === id)!; return n + o.price!.price_paise + o.price!.tax_paise; }, 0);
      const p = reg.participants as unknown as { full_name: string };
      const instructions = String(ctx.event.settings.payment_instructions ?? '');

      body = (
        <>
          <Card title={`${reg.registration_code} · ${p.full_name}`} sub={`${classLabel(reg.classification)} · ${(reg.packages as unknown as { name: string }).name}`}
            actions={<Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/participants/${regId}`}>Participant</Link>}>
            {reg.status !== 'active' ? <div className="alert alert-err">This registration is {reg.status}.</div> : null}
            <div className="label" style={{ marginBottom: 8 }}>Included in the sponsored package (no charge) <SourceTag source="package" /></div>
            <div className="row small" style={{ gap: 6 }}>{snap.tests.map((t) => <span key={t.test_id} className="badge plain">{t.name}</span>)}</div>
          </Card>
          {sp.order ? (
            <Card title="Order created" className="">
              <div className="alert alert-warn">Payment pending. The add-on test will only be queued after an authorised cashier verifies the payment.</div>
              {instructions ? <p className="text2">{instructions}</p> : <p className="muted small">No payment instructions configured for this event.</p>}
            </Card>
          ) : null}
          <div className="grid grid-2">
            <Card title="Add-on tests (employee-paid)" sub="Only tests outside this participant's package are offered.">
              {offer.length ? (
                <form method="get" action={base}>
                  <input type="hidden" name="at" value={desk} /><input type="hidden" name="reg" value={regId} /><input type="hidden" name="review" value="1" />
                  <ul className="list">{offer.map((o) => (
                    <li key={o.id}><label className="check"><input type="checkbox" name="t" value={o.id} defaultChecked={selected.includes(o.id)} disabled={!o.price} />
                      <span><span className="strong">{o.display_name}</span> <span className="small muted">· {locationLabel(o.location)}</span></span></label>
                      <span className="strong">{o.price ? inr(o.price.price_paise + o.price.tax_paise) : <span className="badge red">no price</span>}</span></li>))}</ul>
                  <button className="btn btn-ghost" style={{ marginTop: 12 }}>Review total</button>
                </form>
              ) : <Empty>No add-on tests available for this participant.</Empty>}
              {coveredByPackage.length ? <p className="small muted" style={{ marginTop: 10 }}>Not offered because already free in this participant’s package: {coveredByPackage.map((t) => t.display_name).join(', ')}.</p> : null}
              {ordered.size ? <p className="small muted" style={{ marginTop: 6 }}>Already ordered: {(catalog ?? []).filter((t) => ordered.has(t.id)).map((t) => t.display_name).join(', ')}.</p> : null}
            </Card>
            <Card title="Confirm with the participant">
              {sp.review && selected.length ? (
                <form action={createAddonOrder}>
                  <input type="hidden" name="event_id" value={eventId} /><input type="hidden" name="reg" value={regId} /><input type="hidden" name="desk" value={desk} />
                  <input type="hidden" name="idem" value={await idemKey()} />
                  {selected.map((id) => <input key={id} type="hidden" name="test_ids" value={id} />)}
                  <ul className="list">{selected.map((id) => { const o = offer.find((x) => x.id === id)!; return (
                    <li key={id}><span>{o.display_name}{o.price!.tax_paise ? <span className="small muted"> (incl. {inr(o.price!.tax_paise)} tax/fee)</span> : null}</span><span>{inr(o.price!.price_paise + o.price!.tax_paise)}</span></li>); })}
                    <li><span className="strong">Total payable by participant</span><span className="strong" style={{ fontSize: '1.3rem' }}>{inr(total)}</span></li></ul>
                  <label className="check" style={{ marginTop: 10 }}><input type="checkbox" name="consent" required /><span className="small">Participant confirmed the tests and the total above.</span></label>
                  <div style={{ marginTop: 12 }}><SubmitButton className="btn btn-accent btn-block">Create add-on order</SubmitButton></div>
                </form>
              ) : <p className="muted small">Select tests and choose “Review total”.</p>}
              {intents?.length ? (<><div className="hr" /><div className="label">Existing add-on payments</div>
                <ul className="list">{intents.map((i) => <li key={i.id}><span>{inr(i.amount_paise)}</span><StatusBadge status={i.status} /></li>)}</ul></>) : null}
            </Card>
          </div>
        </>
      );
    }
  }

  const matches = desk && sp.scan && !regId ? await searchRegistrations(ctx, sp.scan) : [];
  return (
    <>
      <PageHead title="Add-on desk" meta="Optional tests outside the sponsored package, paid by the employee." />
      <DutyPicker stations={stations} base={base} title="Desk" current={desk} />
      {desk ? <Card><ScanBox action={base} hidden={{ at: desk }} /></Card> : null}
      {desk && sp.scan && !regId ? <ScanMatches query={sp.scan} matches={matches} hrefFor={(id) => `${base}?at=${desk}&reg=${id}`} /> : null}
      {body}
    </>
  );
}
