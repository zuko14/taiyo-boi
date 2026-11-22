import Link from 'next/link';
import { DutyPicker } from '@/components/DutyPicker';
import { Icon } from '@/components/Icons';
import { ScanBox } from '@/components/ScanBox';
import { ReferralFields } from '@/components/Referral';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, PageHead, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { myStations } from '@/lib/duty';
import { classLabel, dt, priceWithDiscount } from '@/lib/format';
import { TestPicker, type PickTest } from '@/components/TestPicker';
import { idemKey } from '@/lib/supabase/server';
import { loadPickTests } from '@/lib/pick-tests';
import { registerParticipant } from './actions';

type SP = Promise<{ at?: string; employee_id?: string; mobile?: string; name?: string; checked?: string }>;

export default async function RegisterPage({ params, searchParams }: { params: Promise<{ eventId: string }>; searchParams: SP }) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm(eventId, 'registration.create');
  const { stations } = await myStations(ctx, ['registration_counter']);
  const counter = sp.at ?? (stations.length === 1 ? stations[0].id : undefined);
  const base = `/e/${eventId}/register`;
  const { data: packages } = await ctx.supabase.from('packages').select('id, classification, name, active, price_paise, mrp_paise, discount_pct').eq('event_id', eventId).order('classification');
  const canOverride = ctx.can('registration.classification_override');
  const requireConsent = ctx.event.settings.require_consent !== false;
  const custom = ctx.event.settings.package_mode !== 'female_male';
  const sponsored = !custom || ctx.event.settings.payment_model === 'sponsored';
  const sellTests = custom && !sponsored;
  // pay-per-test camps: the event's priced, sellable tests (current price; server recomputes)
  const [pickTests, { data: pkgTests }] = sellTests ? await Promise.all([
    loadPickTests(ctx),
    ctx.supabase.from('package_tests').select('test_id, packages!inner(classification)').eq('event_id', eventId),
  ]) : [[] as PickTest[], { data: [] }];
  const packageTests: Record<string, string[]> = {};
  for (const x of pkgTests ?? []) { const c = (x.packages as unknown as { classification: string }).classification; (packageTests[c] ??= []).push(x.test_id); }
  const pkgChoices = (packages ?? []).filter((p) => p.classification !== 'pay_per_test');
  const canDiscount = sellTests && ctx.can('registration.discount');
  const packagePrices: Record<string, number> = Object.fromEntries(pkgChoices.filter((p) => p.active && (p.price_paise ?? 0) > 0).map((p) => [p.classification, p.price_paise!]));
  // what each package contains, shown on its card so the desk can tell the patient
  const { data: contents } = await ctx.supabase.from('package_tests').select('package_id, test_catalog(display_name)').eq('event_id', eventId);
  const testsOf = (pkgId: string) => (contents ?? []).filter((c) => c.package_id === pkgId).map((c) => (c.test_catalog as unknown as { display_name: string }).display_name).sort();

  // doctors offering free consultations (no queue); a custom camp may register a patient for a consultation only
  const { data: doctors } = await ctx.supabase.from('doctors').select('id, name, specialization, notes').eq('event_id', eventId).eq('active', true).order('name');
  const docs = doctors ?? [];
  const testsOnly = sellTests && pickTests.some((t) => t.price_paise != null);
  const consultOnly = custom && docs.length > 0 && !testsOnly;
  const checked = sp.checked === '1';
  const dupes = checked && (sp.employee_id || sp.mobile || sp.name)
    ? (await ctx.supabase.rpc('find_possible_duplicates', { p_event: eventId, p_employee_id: sp.employee_id ?? '', p_mobile: sp.mobile ?? '', p_name: sp.name ?? '' })).data ?? []
    : [];

  return (
    <>
      <PageHead title="Registration desk" meta={ctx.event.status !== 'live' ? <span className="badge amber">Event is {ctx.event.status}: registration is blocked until it is live</span> : 'Register the patient, or check for an existing registration first.'} />
      <div className={`alert ${sponsored ? 'alert-info' : 'alert-warn'}`} role="note">
        {/* one span: .alert is a flex row, so bare text and <strong> would become separate columns */}
        {sponsored ? <span><strong>Sponsored camp</strong> — the organiser pays. Participants pay nothing here.</span>
          : <span><strong>Patients pay at registration</strong> — pick their tests or package, then collect by UPI QR{(ctx.event.settings.payment_methods as string[] | undefined)?.includes('cash') ? ' or cash' : ''} on the next screen. Tests start only after the payment is confirmed.</span>}
      </div>
      <DutyPicker stations={stations} base={base} title="Counter" current={counter} />
      {counter ? (
        <div className="grid grid-2">
          <Card title="1 · Register new patient" sub={sellTests ? 'Choose a package, individual paid tests, or both.' : custom ? 'Choose the package.' : 'The package is selected automatically from the Female/Male classification.'}>
            <form action={registerParticipant}>
              <input type="hidden" name="event_id" value={eventId} /><input type="hidden" name="counter" value={counter} />
              <input type="hidden" name="idem" value={await idemKey()} />
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="label" style={{ marginBottom: 8 }}>{custom ? 'Package' : 'Classification (required)'}</legend>
                <div className="choice-cards">
                  {consultOnly ? (
                    <label className="choice-card">
                      <input type="radio" name="classification" value="" defaultChecked />
                      <span className="title">Doctor consultation only</span>
                      <span className="small text2">No package or tests now — pick the doctor below</span>
                      <span className="small muted">Free consultation</span>
                    </label>) : null}
                  {testsOnly ? (
                    <label className="choice-card">
                      <input type="radio" name="classification" value="" defaultChecked />
                      <span className="title">Tests only</span>
                      <span className="small text2">No package — pick tests below{docs.length ? ', or only a doctor consultation' : ''}</span>
                      <span className="small muted">Pays for the selected tests</span>
                    </label>) : null}
                  {pkgChoices.map((p) => (
                    <label key={p.id} className="choice-card">
                      <input type="radio" name="classification" value={p.classification} required={!testsOnly && !consultOnly} disabled={!p.active} />
                      <span className="title">{classLabel(p.classification)}</span>
                      <span className="small text2">{p.name}</span>
                      {testsOf(p.id).length ? <span className="small muted" title={testsOf(p.id).join(', ')}>{testsOf(p.id).length} tests: {testsOf(p.id).slice(0, 5).join(', ')}{testsOf(p.id).length > 5 ? ` +${testsOf(p.id).length - 5} more` : ''}</span> : null}
                      <span className="small muted">{sponsored ? 'Sponsored · participant pays ₹0' : p.price_paise ? `Participant pays ${priceWithDiscount(p.price_paise, p.mrp_paise, p.discount_pct)}` : 'Free for the participant'}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {sellTests && (pickTests.length || (canDiscount && Object.keys(packagePrices).length))
                ? <TestPicker tests={pickTests} packageTests={packageTests} priceHref={ctx.can('addon.price.edit') ? `/e/${eventId}/admin/prices` : undefined}
                    canDiscount={canDiscount} packagePrices={packagePrices} /> : null}
              {sellTests && !pickTests.length ? <p className="small muted">No priced tests yet — add them (or upload a CSV) in the Test catalogue to sell individual tests here.</p> : null}
              <div className="field"><label htmlFor="full_name">Full name</label><input id="full_name" name="full_name" required maxLength={120} defaultValue={sp.name} autoFocus /></div>
              <div className="form-row">
                <div className="field"><label htmlFor="age">Age</label><input id="age" name="age" type="number" min={0} max={120} /></div>
                <div className="field"><label htmlFor="employee_id">Employee ID</label><input id="employee_id" name="employee_id" maxLength={40} defaultValue={sp.employee_id} /></div>
                <div className="field"><label htmlFor="mobile">Mobile (10 digits)</label><input id="mobile" name="mobile" inputMode="numeric" pattern="[0-9]{10}" defaultValue={sp.mobile} />
                  <span className="help">Used for report-access codes, if consented.</span></div>
              </div>
              <details style={{ marginBottom: 12 }}><summary className="small text2" style={{ cursor: 'pointer' }}>Optional fields (only if approved by the client)</summary>
                <div className="form-row" style={{ marginTop: 10 }}>
                  <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" /></div>
                  <div className="field"><label htmlFor="department">Department</label><input id="department" name="department" /></div>
                </div>
              </details>
              {canOverride ? (
                <details style={{ marginBottom: 12 }}><summary className="small text2" style={{ cursor: 'pointer' }}>Supervisor: package override (audited)</summary>
                  <div className="form-row" style={{ marginTop: 10 }}>
                    <div className="field"><label htmlFor="po">Override package</label>
                      <select id="po" name="package_override" defaultValue=""><option value="">No override</option>
                        {(packages ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
                    <div className="field"><label htmlFor="or">Reason</label><input id="or" name="override_reason" /></div>
                  </div>
                </details>
              ) : null}
              {docs.length ? (
                <div className="field"><label htmlFor="doctor_id">Free doctor consultation (optional)</label>
                  <select id="doctor_id" name="doctor_id" defaultValue=""><option value="">No consultation</option>
                    {docs.map((d) => <option key={d.id} value={d.id}>{d.name}{d.specialization ? ` — ${d.specialization}` : ''}{d.notes ? ` (${d.notes})` : ''}</option>)}</select>
                  <span className="help">Books a free consultation (no queue). Tests the doctor advises are added later from “Existing patient”, linked to this consultation.</span></div>) : null}
              <ReferralFields doctors={docs} help="If a doctor sent the patient for these tests." />
              <label className="check"><input type="checkbox" name="consent" required={requireConsent} data-required={requireConsent ? '1' : '0'} />
                <span className="small">Participant has read the privacy notice and consents to registration{requireConsent ? ' (required)' : ''}{custom ? ', and confirms the selected tests and price' : ''}.</span></label>
              <div style={{ marginTop: 14 }}><SubmitButton className="btn btn-accent btn-lg btn-block">Register patient</SubmitButton></div>
            </form>
          </Card>
          <Card title="2 · Existing patient" sub="Already registered (did tests, or saw a doctor)? Do not register again — open them here to book a doctor consultation or add the tests the doctor advised.">
            <ScanBox action={`${base}/existing`} hidden={{ at: counter }} label="Scan tag, or type code / name / mobile" />
            <div className="label" style={{ margin: '16px 0 6px' }}>Or check for a duplicate before registering someone new</div>
            <form method="get" action={base}>
              <input type="hidden" name="at" value={counter} /><input type="hidden" name="checked" value="1" />
              <div className="form-row">
                <div className="field"><label htmlFor="q-emp">Employee ID</label><input id="q-emp" name="employee_id" defaultValue={sp.employee_id} /></div>
                <div className="field"><label htmlFor="q-mob">Mobile</label><input id="q-mob" name="mobile" inputMode="numeric" defaultValue={sp.mobile} /></div>
              </div>
              <div className="field"><label htmlFor="q-name">Full name</label><input id="q-name" name="name" defaultValue={sp.name} /></div>
              <button className="btn btn-ghost"><Icon name="search" />Check duplicates</button>
            </form>
            {checked ? (dupes.length ? (
              <div style={{ marginTop: 16 }}>
                <div className="alert alert-warn" role="alert">Possible existing registration{dupes.length > 1 ? 's' : ''}. Confirm with the participant before creating a new one.</div>
                <ul className="list">{dupes.map((d: { registration_id: string; registration_code: string; full_name: string; match: string; status: string; created_at: string; classification: string; mobile_last4: string | null }) => (
                  <li key={d.registration_id}>
                    <div><Link className="strong" href={`${base}/existing?at=${counter}&reg=${d.registration_id}`}>{d.registration_code}</Link> · {d.full_name}
                      <div className="small muted">matched on {d.match} · {classLabel(d.classification)} · mobile …{d.mobile_last4 ?? '—'} · {dt(d.created_at, ctx.event.timezone)}</div></div>
                    <StatusBadge status={d.status} />
                  </li>))}</ul>
              </div>
            ) : <div className="alert alert-ok" style={{ marginTop: 16 }}>No existing registration found for these details.</div>) : null}
          </Card>

        </div>
      ) : null}
    </>
  );
}
