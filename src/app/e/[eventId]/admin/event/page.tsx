import Link from 'next/link';
import { AdminForm, isLive } from '@/components/AdminForm';
import { RpcForm } from '@/components/RpcForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, PageHead, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { dt, isoToLocalInput } from '@/lib/format';
import { labelSettings } from '@/lib/label';
import { nowMs } from '@/lib/clock';
import { deleteEvent, resetEvent, saveEventProfile, saveEventSettings, savePaymentSetup } from '../actions';
import { UpiPay } from '@/components/UpiPay';

const CODE_PRESETS = [
  { f: '{PREFIX}-{CLS}-{YEAR}-{SEQ}', label: 'Prefix, package, year, number' },
  { f: '{PREFIX}{SEQ}', label: 'Prefix + number' },
  { f: '{PREFIX}-{SEQ}', label: 'Prefix - number' },
  { f: '{PREFIX}{CLS}{SEQ}', label: 'Prefix + package letter + number' },
  { f: '{PREFIX}-{YEAR}-{SEQ}', label: 'Prefix, year, number' },
];
/** Same rule as the database (_next_registration_code), for the preview only. */
const codeExample = (format: string, e: { code_prefix: string; code_year: number; code_seq_digits: number }, letter: string) =>
  format.replaceAll('{PREFIX}', e.code_prefix).replaceAll('{CLS}', letter).replaceAll('{YEAR}', String(e.code_year)).replaceAll('{SEQ}', '1'.padStart(e.code_seq_digits, '0')).toUpperCase();

const NEXT: Record<string, string[]> = { draft: ['ready', 'live'], ready: ['draft', 'live'], live: ['paused', 'closed'], paused: ['live', 'closed'], closed: ['live', 'archived'], archived: [] };

export default async function EventAdmin({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await requirePerm(eventId, 'event.configure');
  const e = ctx.event;
  const tz = e.timezone;
  const back = `/e/${eventId}/admin/event`;
  const live = isLive(e.status);
  const { data: checks } = await ctx.supabase.rpc('validate_event', { p_event: eventId });
  const errors = (checks ?? []).filter((c: { level: string }) => c.level === 'error');
  const s = e.settings as Record<string, unknown>;
  const methods = (s.payment_methods as string[] | undefined) ?? [];
  const l = labelSettings(s);
  const f = (k: string) => String(e[k] ?? '');
  const { data: pk } = await ctx.supabase.from('packages').select('code_letter').eq('event_id', eventId).eq('active', true).order('classification');
  const letters = [...new Set((pk ?? []).map((p) => p.code_letter as string).filter(Boolean))];
  if (!letters.length) letters.push('A');
  const fmt = String(e.code_format);
  const { data: until } = await ctx.supabase.rpc('reports_window', { p_event: eventId });
  const reportsUntil = until ? new Date(until as string) : null;
  const reportsClosed = !!reportsUntil && reportsUntil.getTime() <= nowMs();
  const cfg = { code_prefix: String(e.code_prefix), code_year: Number(e.code_year), code_seq_digits: Number(e.code_seq_digits) };

  return (
    <>
      <PageHead title="Event & readiness" meta={<>{e.code} · <StatusBadge status={e.status} /></>}>
        <Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/tag-test`}>Test print a label</Link>
      </PageHead>
      <div className="grid grid-2">
        <Card title="Readiness checks" sub="Errors block Ready/Live. Warnings must be resolved with the Lab Partner before production.">
          {(checks ?? []).length ? <ul className="list">{(checks ?? []).map((c: { level: string; message: string }, i: number) => (
            <li key={i}><span className="small">{c.message}{/has no compatible (diagnostic station|walk-in centre)/.test(c.message) ? <> — <Link href={`/e/${eventId}/admin/stations`}>fix in Stations &amp; counters → Visits</Link></> : null}</span><span className={`badge ${c.level === 'error' ? 'red' : 'amber'}`}>{c.level}</span></li>))}</ul>
            : <div className="alert alert-ok">No issues found.</div>}
        </Card>
        <Card title="Event status">
          <p className="small text2">Registration and station work only happen while the event is <strong>Live</strong>. Pausing stops all operational changes.</p>
          <RpcForm eventId={eventId} rpc="set_event_status" back={back} ok="Event status changed" hidden={{ p_event: eventId }}>
            <div className="form-row">
              <div className="field"><label htmlFor="st">New status</label><select id="st" name="p_status" required>{NEXT[e.status].map((n) => <option key={n} value={n}>{n}</option>)}</select></div>
              <div className="field"><label htmlFor="sr">Reason{live ? ' (required)' : ''}</label><input id="sr" name="p_reason" required={live} /></div>
            </div>
            <SubmitButton className="btn btn-solid" disabled={!NEXT[e.status].length}>Change status</SubmitButton>
            {errors.length ? <p className="small muted" style={{ marginTop: 8 }}>{errors.length} error(s) must be fixed before Ready/Live.</p> : null}
          </RpcForm>
        </Card>
      </div>

      <Card title="Payments at this camp" sub="Decide who pays, then how money is received on the spot. Staff see this on every desk.">
        <AdminForm action={savePaymentSetup} eventId={eventId} back={back} live={live}>
          {e.settings.package_mode === 'female_male' ? (
            <div className="alert alert-info">Sponsored event (Bank of India template): the company pays for the packages, employees pay nothing at registration. Only optional add-on tests at the add-on desk are paid by the employee.</div>
          ) : (
            <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
              <legend className="label" style={{ marginBottom: 8 }}>Who pays for the tests?</legend>
              <div className="choice-cards">
                <label className="choice-card"><input type="radio" name="payment_model" value="patient_pays" defaultChecked={s.payment_model !== 'sponsored'} />
                  <span className="title">Patients pay at registration</span>
                  <span className="small text2">Apartments, societies, public camps: the desk picks tests or a package, the patient pays by UPI QR or cash, and tests start after payment is confirmed.</span></label>
                <label className="choice-card"><input type="radio" name="payment_model" value="sponsored" defaultChecked={s.payment_model === 'sponsored'} />
                  <span className="title">Sponsored — organiser pays</span>
                  <span className="small text2">Company / corporate camps: patients pay nothing at registration; packages are free for them.</span></label>
              </div>
            </fieldset>)}
          <div className="label">Receive payments by UPI QR</div>
          <div className="form-row">
            <div className="field"><label htmlFor="upi_vpa">UPI ID of the receiving bank account</label><input id="upi_vpa" name="upi_vpa" defaultValue={String(s.upi_vpa ?? '')} placeholder="taiyolabs@okicici" autoComplete="off" inputMode="email" />
              <span className="help">Find it in the bank&apos;s or business UPI app (PhonePe Business, GPay for Business, Paytm, BHIM), or printed under the lab&apos;s QR. Money paid through the QR goes straight to the bank account behind this UPI ID.</span></div>
            <div className="field"><label htmlFor="upi_payee_name">Account holder name</label><input id="upi_payee_name" name="upi_payee_name" defaultValue={String(s.upi_payee_name ?? '')} placeholder="Taiyo Labs Pvt Ltd" />
              <span className="help">Exactly as the bank shows it — the patient&apos;s UPI app displays it before they pay.</span></div>
          </div>
          <label className="check"><input type="checkbox" name="accept_cash" defaultChecked={methods.includes('cash')} />Also accept cash at the desk</label>
          <div className="field" style={{ marginTop: 8 }}><label htmlFor="pi">Payment note shown at the desk (optional)</label><input id="pi" name="payment_instructions" defaultValue={String(s.payment_instructions ?? '')} placeholder="e.g. Pay by scanning the QR; show the success screen to the desk" /></div>
          <input type="hidden" name="payment_methods_extra" value={methods.filter((m) => !['cash', 'upi_manual'].includes(m)).join(', ')} />
          <SubmitButton>Save payment setup</SubmitButton>
        </AdminForm>
        {s.upi_vpa ? (
          <div style={{ marginTop: 16 }}>
            <div className="label">Check it before the camp: scan this ₹1 test QR with your own phone</div>
            <p className="small text2" style={{ margin: '4px 0 0' }}>Your UPI app must show <strong>{String(s.upi_payee_name || s.upi_vpa)}</strong> and ₹1.00. If the name is wrong, fix the UPI ID before patients pay. Every patient QR is made the same way, with their exact amount and registration code.</p>
            <UpiPay settings={s} amountPaise={100} reference="TEST-SCAN" />
          </div>) : null}
      </Card>

      <Card title="Event profile">
        <AdminForm action={saveEventProfile} eventId={eventId} back={back} live={live}>
          <div className="form-row">
            <div className="field"><label>Event name</label><input name="name" defaultValue={e.name} required /></div>
            <div className="field"><label>Sponsor</label><input name="sponsor_name" defaultValue={e.sponsor_name} /></div>
            <div className="field"><label>Lab Partner display/legal name</label><input name="lab_partner_name" defaultValue={e.lab_partner_name} placeholder="To be confirmed before launch" /></div>
          </div>
          <div className="form-row">
            <div className="field"><label>Venue</label><input name="venue" defaultValue={e.venue} /></div>
            <div className="field"><label>Help / contact</label><input name="help_contact" defaultValue={e.help_contact} /></div>
            <div className="field"><label>Timezone</label><input name="timezone" defaultValue={tz} /></div>
          </div>
          <div className="form-row">
            <div className="field"><label>Starts</label><input type="datetime-local" name="starts_at" defaultValue={isoToLocalInput(f('starts_at') || null, tz)} /></div>
            <div className="field"><label>Ends</label><input type="datetime-local" name="ends_at" defaultValue={isoToLocalInput(f('ends_at') || null, tz)} /></div>
            <div className="field"><label>Registration opens</label><input type="datetime-local" name="registration_opens_at" defaultValue={isoToLocalInput(f('registration_opens_at') || null, tz)} /></div>
            <div className="field"><label>Registration closes</label><input type="datetime-local" name="registration_closes_at" defaultValue={isoToLocalInput(f('registration_closes_at') || null, tz)} /></div>
          </div>
          <div className="field"><label>Participant portal instructions</label><textarea name="portal_instructions" rows={2} defaultValue={e.portal_instructions} /></div>
          <div className="form-row">
            <div className="field"><label>Expected attendance</label><input type="number" name="expected_attendance" defaultValue={f('expected_attendance')} /></div>
          </div>
          <div className="label" style={{ marginTop: 6 }}>Patient registration code</div>
          <p className="small text2" style={{ margin: '2px 0 10px' }}>Printed on the tag and used to search patients. Changing it affects new registrations only; codes already issued never change and are never reused.</p>
          <div className="form-row">
            <div className="field"><label htmlFor="cf">Format</label>
              <select id="cf" name="code_format_preset" defaultValue={CODE_PRESETS.some((x) => x.f === fmt) ? fmt : 'custom'}>
                {CODE_PRESETS.map((x) => <option key={x.f} value={x.f}>{x.label} — e.g. {codeExample(x.f, cfg, letters[0])}</option>)}
                <option value="custom">Custom (type below)</option>
              </select></div>
            <div className="field"><label htmlFor="cfc">Custom format (only when Format is Custom)</label><input id="cfc" name="code_format" defaultValue={fmt} placeholder="{PREFIX}{SEQ}" />
              <span className="help">{'{PREFIX}'} prefix · {'{CLS}'} package letter · {'{YEAR}'} year · {'{SEQ}'} running number (required). Other characters are kept, e.g. <span className="mono">{'CAMP-{SEQ}'}</span>.</span></div>
          </div>
          <div className="form-row">
            <div className="field"><label htmlFor="cp">Prefix</label><input id="cp" name="code_prefix" defaultValue={f('code_prefix')} pattern="[A-Za-z0-9]{1,8}" required /><span className="help">1–8 letters/digits, e.g. VV</span></div>
            <div className="field"><label htmlFor="cy">Year</label><input id="cy" type="number" name="code_year" defaultValue={f('code_year')} /></div>
            <div className="field"><label htmlFor="cd">Number digits</label><input id="cd" type="number" name="code_seq_digits" min={3} max={9} defaultValue={f('code_seq_digits')} /><span className="help">3 → 001, 002 … (grows past 999 automatically)</span></div>
          </div>
          <div className="alert alert-info" style={{ marginBottom: 12 }}><span>Codes will look like: <strong className="mono">{letters.map((l) => codeExample(fmt, cfg, l)).filter((v, i, a) => a.indexOf(v) === i).join(' · ')}</strong>{fmt.includes('{CLS}') ? ' (each package has its own running number)' : ' (one running number shared by all packages)'}</span></div>
          <SubmitButton>Save profile</SubmitButton>
        </AdminForm>
      </Card>

      <Card title="Operational settings">
        <AdminForm action={saveEventSettings} eventId={eventId} back={back} live={live}>
          <div className="grid grid-2">
            <div>
              <label className="check"><input type="checkbox" name="require_consent" defaultChecked={s.require_consent !== false} />Require participant consent at registration</label>
              <label className="check"><input type="checkbox" name="payment_maker_checker" defaultChecked={s.payment_maker_checker !== false} />Order creator cannot verify the same payment</label>
              <label className="check"><input type="checkbox" name="report_maker_checker" defaultChecked={s.report_maker_checker !== false} />Report uploader cannot validate the same report</label>
              <label className="check"><input type="checkbox" name="grouping_approved" defaultChecked={s.grouping_approved === true} />Lab Partner has approved the test-to-service grouping</label>
              <div className="field" style={{ marginTop: 10 }}><label>Default service minutes (queue estimate)</label><input type="number" name="default_service_minutes" min={1} defaultValue={String(s.default_service_minutes ?? 5)} /></div>
            </div>
            <div>
              <p className="small muted">Who pays, UPI and cash are set in <strong>Payments at this camp</strong> above.</p>
            </div>
          </div>
          <div className="label" style={{ marginTop: 6 }}>Online reports for patients</div>
          <p className="small text2" style={{ margin: '2px 0 8px' }}>Patients open their reports by scanning the tag QR (with a one-time code). After the window below, the portal stops showing reports and tells them to collect them at the walk-in centre.</p>
          <div className="form-row">
            <div className="field"><label htmlFor="rad">Days reports stay online after the camp</label>
              <input id="rad" type="number" name="report_access_days" min={0} max={365} defaultValue={String(s.report_access_days ?? '')} placeholder="No limit" />
              <span className="help">Blank = no limit. 0 = only until the end of the camp day. 3 = until 11:59 pm on the third day after the camp ends (event end date).</span></div>
            <div className="field"><label htmlFor="rcn">Message after the window closes (optional)</label>
              <input id="rcn" name="report_closed_note" maxLength={300} defaultValue={String(s.report_closed_note ?? '')} placeholder="Please collect your reports at the walk-in centre. Bring your tag or registration code." /></div>
          </div>
          <div className={`alert ${reportsUntil && reportsClosed ? 'alert-warn' : 'alert-info'}`} style={{ marginBottom: 12 }}><span>{reportsUntil
            ? <>Reports are online until <strong>{dt(new Date(reportsUntil.getTime() - 60_000).toISOString(), tz)}</strong>{reportsClosed ? ' — the window has closed; patients are sent to the walk-in centre.' : '.'}</>
            : s.report_access_days != null && s.report_access_days !== '' ? <>Set the event <strong>Ends</strong> date in Event profile — the window is counted from it. Until then reports stay online without a limit.</> : 'Reports stay online with no time limit.'}</span></div>
          <div className="label" style={{ marginTop: 6 }}>Tag label</div>
          <div className="form-row">
            <div className="field"><label>Width (mm)</label><input type="number" name="label_w" defaultValue={l.w} min={30} max={200} /></div>
            <div className="field"><label>Height (mm)</label><input type="number" name="label_h" defaultValue={l.h} min={20} max={200} /></div>
            <label className="check" style={{ alignSelf: 'center' }}><input type="checkbox" name="label_show_age" defaultChecked={l.showAge} />Show age on tag (if approved)</label>
          </div>
          <SubmitButton>Save settings</SubmitButton>
        </AdminForm>
      </Card>

      {ctx.can('event.reset') || ctx.profile.is_platform_admin ? (
        <Card title="Danger zone" sub="Use after a pilot or mock run so the same event can be used for the real camp.">
          <div className="grid grid-2">
            {ctx.can('event.reset') ? (
              <form action={resetEvent}>
                <input type="hidden" name="event_id" value={eventId} />
                <div className="strong">Reset event (pilot / test run)</div>
                <p className="small text2">Permanently deletes every participant, registration, tag, add-on order, payment, receipt, queue, attendance record and report file. Packages, tests, prices, stations, staff and permissions are kept. Stations are closed, shifts are cleared, registration codes restart at 1 and the event returns to <strong>Draft</strong>. The audit log keeps a record of the reset.</p>
                <div className="field"><label htmlFor="rs-reason">Reason</label><input id="rs-reason" name="reason" required placeholder="e.g. Pilot run at the apartment camp finished" /></div>
                <div className="field"><label htmlFor="rs-confirm">Type <span className="mono">{e.code}</span> to confirm</label><input id="rs-confirm" name="confirm" required autoComplete="off" /></div>
                <SubmitButton className="btn btn-red" confirm={`Reset ${e.code}? All participant and operational data will be deleted. This cannot be undone.`}>Reset event data</SubmitButton>
              </form>) : null}
            {ctx.profile.is_platform_admin ? (
              <form action={deleteEvent}>
                <input type="hidden" name="event_id" value={eventId} /><input type="hidden" name="back" value={back} />
                <div className="strong">Delete event</div>
                <p className="small text2">Permanently removes this event, all of its data and its configuration. Platform admin only. A live event must be paused or closed first.</p>
                <div className="field"><label htmlFor="del-confirm">Type <span className="mono">{e.code}</span> to confirm</label><input id="del-confirm" name="confirm" required autoComplete="off" /></div>
                <SubmitButton className="btn btn-red" confirm={`Permanently delete ${e.code}? This cannot be undone.`}>Delete event permanently</SubmitButton>
              </form>) : null}
          </div>
        </Card>) : null}
    </>
  );
}
