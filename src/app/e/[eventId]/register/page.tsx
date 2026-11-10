import Link from 'next/link';
import { DutyPicker } from '@/components/DutyPicker';
import { Icon } from '@/components/Icons';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, PageHead, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { myStations } from '@/lib/duty';
import { classLabel, dt } from '@/lib/format';
import { idemKey } from '@/lib/supabase/server';
import { registerParticipant } from './actions';

type SP = Promise<{ at?: string; employee_id?: string; mobile?: string; name?: string; checked?: string }>;

export default async function RegisterPage({ params, searchParams }: { params: Promise<{ eventId: string }>; searchParams: SP }) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm(eventId, 'registration.create');
  const { stations } = await myStations(ctx, ['registration_counter']);
  const counter = sp.at ?? (stations.length === 1 ? stations[0].id : undefined);
  const base = `/e/${eventId}/register`;
  const { data: packages } = await ctx.supabase.from('packages').select('id, classification, name, active').eq('event_id', eventId).order('classification');
  const canOverride = ctx.can('registration.classification_override');
  const requireConsent = ctx.event.settings.require_consent !== false;

  const checked = sp.checked === '1';
  const dupes = checked && (sp.employee_id || sp.mobile || sp.name)
    ? (await ctx.supabase.rpc('find_possible_duplicates', { p_event: eventId, p_employee_id: sp.employee_id ?? '', p_mobile: sp.mobile ?? '', p_name: sp.name ?? '' })).data ?? []
    : [];

  return (
    <>
      <PageHead title="Registration desk" meta={ctx.event.status !== 'live' ? <span className="badge amber">Event is {ctx.event.status}: registration is blocked until it is live</span> : 'Search first, then register once.'} />
      <DutyPicker stations={stations} base={base} title="Counter" current={counter} />
      {counter ? (
        <div className="grid grid-2">
          <Card title="1 · Check for an existing registration" sub="Search by an approved identifier before creating a new entry.">
            <form method="get" action={base}>
              <input type="hidden" name="at" value={counter} /><input type="hidden" name="checked" value="1" />
              <div className="form-row">
                <div className="field"><label htmlFor="q-emp">Employee ID</label><input id="q-emp" name="employee_id" defaultValue={sp.employee_id} autoFocus /></div>
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
                    <div><Link className="strong" href={`/e/${eventId}/participants/${d.registration_id}`}>{d.registration_code}</Link> · {d.full_name}
                      <div className="small muted">matched on {d.match} · {classLabel(d.classification)} · mobile …{d.mobile_last4 ?? '—'} · {dt(d.created_at, ctx.event.timezone)}</div></div>
                    <StatusBadge status={d.status} />
                  </li>))}</ul>
              </div>
            ) : <div className="alert alert-ok" style={{ marginTop: 16 }}>No existing registration found for these details.</div>) : null}
          </Card>

          <Card title="2 · Register participant" sub="The package is selected automatically from the Female/Male classification.">
            <form action={registerParticipant}>
              <input type="hidden" name="event_id" value={eventId} /><input type="hidden" name="counter" value={counter} />
              <input type="hidden" name="idem" value={await idemKey()} />
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="label" style={{ marginBottom: 8 }}>Classification (required)</legend>
                <div className="choice-cards">
                  {(packages ?? []).map((p) => (
                    <label key={p.id} className="choice-card">
                      <input type="radio" name="classification" value={p.classification} required disabled={!p.active} />
                      <span className="title">{classLabel(p.classification)}</span>
                      <span className="small text2">{p.name}</span>
                      <span className="small muted">Sponsored · employee pays ₹0</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="field"><label htmlFor="full_name">Full name</label><input id="full_name" name="full_name" required maxLength={120} defaultValue={sp.name} /></div>
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
              <label className="check"><input type="checkbox" name="consent" required={requireConsent} />
                <span className="small">Participant has read the privacy notice and consents to registration{requireConsent ? ' (required)' : ''}.</span></label>
              <div style={{ marginTop: 14 }}><SubmitButton className="btn btn-accent btn-lg btn-block">Register and print tag</SubmitButton></div>
            </form>
          </Card>
        </div>
      ) : null}
    </>
  );
}
