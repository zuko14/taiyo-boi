import Link from 'next/link';
import type { ReactNode } from 'react';
import { DutyPicker } from '@/components/DutyPicker';
import { ReasonAction, RpcForm } from '@/components/RpcForm';
import { ScanBox } from '@/components/ScanBox';
import { ScanMatches } from '@/components/ScanMatches';
import { ReferralFields } from '@/components/Referral';
import { SubmitButton } from '@/components/SubmitButton';
import { TestPicker } from '@/components/TestPicker';
import { Card, Empty, PageHead, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { myStations } from '@/lib/duty';
import { classLabel, dt, inr } from '@/lib/format';
import { loadPickTests } from '@/lib/pick-tests';
import { resolveScan, searchRegistrations } from '@/lib/scan';
import { idemKey } from '@/lib/supabase/server';
import { addTestsForPatient } from './actions';

type SP = Promise<{ at?: string; reg?: string; scan?: string }>;
type Consult = { id: string; status: string; note: string; booked_at: string; completed_at: string | null; cancelled_reason: string | null; doctors: { name: string; specialization: string } };
type Order = { id: string; kind: string; status: string; total_paise: number; created_at: string; consultation_id: string | null; discount_reason: string | null;
  referred_by_doctor_id: string | null; referred_by_name: string | null;
  order_items: { test_name: string; status: string; discount_pct: number }[] };

/** Registration desk, existing patient: never a second registration. Book a doctor consultation or add the tests the doctor advised. */
export default async function ExistingPatient({ params, searchParams }: { params: Promise<{ eventId: string }>; searchParams: SP }) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm(eventId, 'registration.create');
  const tz = ctx.event.timezone;
  const { stations } = await myStations(ctx, ['registration_counter']);
  const counter = sp.at ?? (stations.length === 1 ? stations[0].id : undefined);
  const base = `/e/${eventId}/register/existing`;
  const regId = (sp.reg && /^[0-9a-f-]{36}$/.test(sp.reg) ? sp.reg : null) ?? (sp.scan ? await resolveScan(ctx, sp.scan, counter) : null);
  const matches = !regId && sp.scan ? await searchRegistrations(ctx, sp.scan) : [];
  const here = `${base}?at=${counter}&reg=${regId}`;

  let body = null;
  if (counter && regId) {
    const [{ data: reg }, { data: consults }, { data: orders }, { data: doctors }, pickTests] = await Promise.all([
      ctx.supabase.from('registrations').select('id, registration_code, classification, status, created_at, package_id, referred_by_doctor_id, referred_by_name, participants(full_name, age, mobile), packages(name)').eq('id', regId).eq('event_id', eventId).maybeSingle(),
      ctx.supabase.from('consultations').select('id, status, note, booked_at, completed_at, cancelled_reason, doctors(name, specialization)').eq('registration_id', regId).order('booked_at'),
      ctx.supabase.from('orders').select('id, kind, status, total_paise, created_at, consultation_id, discount_reason, referred_by_doctor_id, referred_by_name, order_items(test_name, status, discount_pct)').eq('registration_id', regId).order('created_at'),
      ctx.supabase.from('doctors').select('id, name, specialization, notes, active').eq('event_id', eventId).order('name'),
      loadPickTests(ctx),
    ]);
    const active = (doctors ?? []).filter((d) => d.active);
    if (!reg) body = <div className="alert alert-err">Registration not found in this event.</div>;
    else {
      const p = reg.participants as unknown as { full_name: string; age: number | null; mobile: string | null };
      const cs = (consults ?? []) as unknown as Consult[];
      const os = (orders ?? []) as unknown as Order[];
      const docName = (id: string | null) => { const c = cs.find((x) => x.id === id); return c ? `${c.doctors.name}${c.doctors.specialization ? ` (${c.doctors.specialization})` : ''}` : null; };
      // tests this patient already has (package or ordered) are not offered again
      const { data: own } = await ctx.supabase.from('order_items').select('test_id').eq('registration_id', regId).eq('status', 'active');
      const pkgOfThis = (await ctx.supabase.from('package_tests').select('test_id').eq('package_id', reg.package_id)).data ?? [];
      const have = [...new Set([...(own ?? []).map((x) => x.test_id as string), ...pkgOfThis.map((x) => x.test_id as string)])];
      const open = cs.filter((c) => c.status !== 'cancelled');
      const docOf = (id: string | null) => (doctors ?? []).find((d) => d.id === id)?.name;
      const referral = (x: { referred_by_doctor_id: string | null; referred_by_name: string | null }) => docOf(x.referred_by_doctor_id) ?? x.referred_by_name;
      const regRef = referral(reg as unknown as { referred_by_doctor_id: string | null; referred_by_name: string | null });
      const firstConsult = open[0]?.booked_at;
      const items = (o: Order) => o.order_items.filter((i) => i.status === 'active').map((i) => `${i.test_name}${Number(i.discount_pct) > 0 ? ` (${Number(i.discount_pct)}% off)` : ''}`).join(', ');
      // journey: registration, consultations and orders in time order, each order marked before/after consultation
      type Ev = { at: string; key: string; node: ReactNode };
      const evs: Ev[] = [
        { at: reg.created_at, key: 'reg', node: <><span className="strong">Registered</span> · {(reg.packages as unknown as { name: string }).name}{regRef ? <>{' '}<span className="badge plain">referred by {regRef}</span></> : null}</> },
        ...cs.map((c) => ({ at: c.booked_at, key: c.id, node: <><span className="strong">Doctor consultation</span> · {c.doctors.name}{c.doctors.specialization ? ` — ${c.doctors.specialization}` : ''} <StatusBadge status={c.status === 'booked' ? 'pending' : c.status} label={c.status === 'booked' ? 'Waiting' : c.status === 'completed' ? 'Done' : 'Cancelled'} />{c.note ? <span className="small muted"> · {c.note}</span> : null}</> })),
        ...os.filter((o) => o.order_items.some((i) => i.status === 'active') && o.status === 'active').map((o) => ({ at: o.created_at, key: o.id, node: <>
          <span className="strong">{o.kind === 'package' ? 'Package tests' : 'Tests'}</span>{' '}{o.consultation_id ? <span className="badge green">after consultation · {docName(o.consultation_id)}</span>
            : firstConsult && o.created_at < firstConsult ? <span className="badge plain">before consultation</span> : null}
          <div className="small text2">{items(o)}{o.total_paise ? ` · ${inr(o.total_paise)}` : ''}{o.discount_reason ? ` · discount: ${o.discount_reason}` : ''}{referral(o) ? ` · referred by ${referral(o)}` : ''}</div></> })),
      ].sort((a, b) => a.at.localeCompare(b.at));

      body = (<>
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="mono strong">{reg.registration_code}</span><span className="strong">{p.full_name}</span>
          <span className="muted small">{classLabel(reg.classification)}{p.age != null ? ` · ${p.age} y` : ''}{p.mobile ? ` · …${p.mobile.slice(-4)}` : ''}</span>
          {reg.status !== 'active' ? <StatusBadge status={reg.status} /> : null}<span className="spacer" />
          <Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/participants/${regId}`}>Full details</Link>
          <Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/participants/${regId}/tag`}>Tag &amp; payment</Link>
        </div>
        <div className="grid grid-2">
          <Card title="Doctor consultation" sub="Free; no queue. Book it, send the patient to the doctor, then mark it done.">
            {cs.length ? <ul className="list">{cs.map((c) => (
              <li key={c.id} style={{ display: 'block' }}>
                <div className="row-between"><span><span className="strong">{c.doctors.name}</span> <span className="small muted">{c.doctors.specialization}</span></span>
                  <StatusBadge status={c.status === 'booked' ? 'pending' : c.status} label={c.status === 'booked' ? 'Waiting' : c.status === 'completed' ? 'Done' : 'Cancelled'} /></div>
                <div className="small muted">Booked {dt(c.booked_at, tz)}{c.completed_at ? ` · done ${dt(c.completed_at, tz)}` : ''}{c.cancelled_reason ? ` · ${c.cancelled_reason}` : ''}</div>
                {c.status === 'booked' ? <div className="row" style={{ marginTop: 6 }}>
                  <RpcForm eventId={eventId} rpc="set_consultation_status" back={here} ok="Consultation marked done" hidden={{ p_consultation: c.id, p_status: 'completed' }}><SubmitButton className="btn btn-green btn-sm">Consultation done</SubmitButton></RpcForm>
                  <ReasonAction eventId={eventId} rpc="set_consultation_status" back={here} hidden={{ p_consultation: c.id, p_status: 'cancelled' }} label="Cancel" ok="Consultation cancelled" />
                </div> : null}
              </li>))}</ul> : <p className="small muted">No consultation yet.</p>}
            {active.length ? (
              <RpcForm eventId={eventId} rpc="book_consultation" back={here} ok="Consultation booked — send the patient to the doctor" hidden={{ p_reg: regId, p_counter: counter }} style={{ marginTop: 12 }}>
                <div className="form-row">
                  <div className="field"><label htmlFor="bk-doc">Book with</label><select id="bk-doc" name="p_doctor" required>
                    {active.map((d) => <option key={d.id} value={d.id}>{d.name}{d.specialization ? ` — ${d.specialization}` : ''}{d.notes ? ` (${d.notes})` : ''}</option>)}</select></div>
                  <div className="field"><label htmlFor="bk-note">Note (optional)</label><input id="bk-note" name="p_note" maxLength={300} placeholder="e.g. follow-up after blood report" /></div>
                </div>
                <SubmitButton>Book free consultation</SubmitButton>
              </RpcForm>) : <p className="small muted">No doctors set up. An admin adds them in Setup → Doctors.</p>}
          </Card>
          <Card title="Add tests for this patient" sub="Same patient, same registration code — the new tests join their queue and payment.">
            <form action={addTestsForPatient}>
              <input type="hidden" name="event_id" value={eventId} /><input type="hidden" name="counter" value={counter} /><input type="hidden" name="reg" value={regId} />
              <input type="hidden" name="idem" value={await idemKey()} />
              <div className="field"><label htmlFor="cons">Advised by</label>
                <select id="cons" name="consultation_id" defaultValue={open[open.length - 1]?.id ?? ''}>
                  <option value="">Not from a doctor consultation</option>
                  {open.map((c) => <option key={c.id} value={c.id}>{c.doctors.name} — consultation {dt(c.booked_at, tz)}</option>)}</select>
                <span className="help">Links these tests to the consultation, so you can see what each doctor&apos;s patients took afterwards.</span></div>
              <ReferralFields doctors={active} help="Leave empty if advised in the consultation chosen above — that doctor is recorded automatically." />
              <TestPicker tests={pickTests} packageTests={{ '': have }} canDiscount={ctx.can('registration.discount')} />
              <label className="check"><input type="checkbox" name="consent" required data-required="1" /><span className="small">Patient confirms the tests and price.</span></label>
              <div style={{ marginTop: 12 }}><SubmitButton className="btn btn-accent btn-block">Add tests</SubmitButton></div>
            </form>
          </Card>
        </div>
        <Card title="Patient journey" sub="Everything this patient did at the camp, in order: before and after each doctor consultation.">
          {evs.length ? <ul className="list">{evs.map((e) => <li key={e.key} style={{ display: 'block' }}><div className="small muted">{dt(e.at, tz)}</div><div>{e.node}</div></li>)}</ul> : <Empty>—</Empty>}
        </Card>
      </>);
    }
  }

  return (
    <>
      <PageHead title="Existing patient" meta="Registration desk · for someone already registered">
        <Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/register${counter ? `?at=${counter}` : ''}`}>New registration</Link>
      </PageHead>
      <DutyPicker stations={stations} base={base} title="Counter" current={counter} />
      {counter ? (<>
        <Card><ScanBox action={base} hidden={{ at: counter }} defaultValue={regId ? undefined : sp.scan} label="Scan tag, or type code / name / mobile" />
          {!regId && sp.scan ? <div style={{ marginTop: 12 }}><ScanMatches query={sp.scan} matches={matches} hrefFor={(id) => `${base}?at=${counter}&reg=${id}`} /></div> : null}
        </Card>
        {body}
      </>) : null}
    </>
  );
}
