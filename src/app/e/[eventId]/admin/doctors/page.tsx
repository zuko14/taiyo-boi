import { AdminForm, isLive } from '@/components/AdminForm';
import { ReferralTable, type ReferralRow } from '@/components/Referral';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, Empty, PageHead } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { inr } from '@/lib/format';
import { saveDoctor } from '../actions';

type Row = { doctor_id: string; name: string; specialization: string; active: boolean; booked: number; completed: number; cancelled: number;
  patients: number; patients_with_tests: number; tests_after: number; amount_after_paise: number; paid_after_paise: number };

export default async function Doctors({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await requirePerm(eventId, 'doctor.manage');
  const back = `/e/${eventId}/admin/doctors`;
  const live = isLive(ctx.event.status);
  const [{ data: stats }, { data: docs }] = await Promise.all([
    ctx.supabase.rpc('doctor_insights', { p_event: eventId }),
    ctx.supabase.from('doctors').select('id, notes').eq('event_id', eventId),
  ]);
  const { data: refRows } = await ctx.supabase.rpc('referral_insights', { p_event: eventId });
  const rows = (stats ?? []) as Row[];
  const notes = (id: string) => (docs ?? []).find((d) => d.id === id)?.notes ?? '';
  const tot = rows.reduce((a, r) => ({ patients: a.patients + r.patients, withTests: a.withTests + r.patients_with_tests, amount: a.amount + r.amount_after_paise }), { patients: 0, withTests: 0, amount: 0 });

  return (
    <>
      <PageHead title="Doctors" meta="Doctors offering free consultations at the camp. No queue: the registration desk books a consultation, and tests the doctor advises are added for the same patient, linked to that consultation." />
      <Card title="Consultations and what followed" sub={rows.length ? `${tot.patients} patient(s) consulted · ${tot.withTests} took tests after · ${inr(tot.amount)} of tests ordered after consultations` : undefined}>
        {rows.length ? (
          <div className="table-wrap"><table><thead><tr><th>Doctor</th><th>Waiting</th><th>Done</th><th>Cancelled</th><th>Patients</th><th>Took tests after</th><th>Tests after</th><th>Ordered after</th><th>Paid</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.doctor_id}><td><span className="strong">{r.name}</span>{r.active ? null : <span className="badge"> inactive</span>}<div className="small muted">{r.specialization || '—'}</div></td>
                <td>{r.booked}</td><td>{r.completed}</td><td>{r.cancelled}</td><td>{r.patients}</td>
                <td>{r.patients_with_tests}{r.patients ? <span className="small muted"> ({Math.round((r.patients_with_tests / r.patients) * 100)}%)</span> : null}</td>
                <td>{r.tests_after}</td><td>{inr(r.amount_after_paise)}</td><td>{inr(r.paid_after_paise)}</td></tr>))}</tbody></table></div>
        ) : <Empty>No doctors yet. Add the first one below.</Empty>}
      </Card>
      <Card title="Referrals" sub="Patients and tests each doctor referred (set at the desk, or from a consultation). Outside doctors are listed by the name typed at the desk.">
        <ReferralTable rows={(refRows ?? []) as ReferralRow[]} money={ctx.can('finance.view')} />
      </Card>
      <div className="grid grid-2">
        <Card title="Add a doctor">
          <AdminForm action={saveDoctor} eventId={eventId} back={back} live={live}>
            <div className="field"><label htmlFor="dn">Name</label><input id="dn" name="name" required maxLength={120} placeholder="Dr. A. Kumar" /></div>
            <div className="field"><label htmlFor="ds">Specialisation</label><input id="ds" name="specialization" maxLength={120} placeholder="General physician, Cardiologist…" /></div>
            <div className="field"><label htmlFor="dno">Note for the desk (optional)</label><input id="dno" name="notes" maxLength={300} placeholder="e.g. Room 4, 10 am – 1 pm" /></div>
            <input type="hidden" name="active" value="on" />
            <SubmitButton>Add doctor</SubmitButton>
          </AdminForm>
        </Card>
        <Card title="Edit doctors" sub="Untick Active when a doctor leaves; their past consultations stay recorded.">
          {rows.length ? <ul className="list">{rows.map((r) => (
            <li key={r.doctor_id} style={{ display: 'block' }}>
              <AdminForm action={saveDoctor} eventId={eventId} back={back} live={live} hidden={{ id: r.doctor_id }}>
                <div className="form-row">
                  <div className="field"><label htmlFor={`n-${r.doctor_id}`}>Name</label><input id={`n-${r.doctor_id}`} name="name" required maxLength={120} defaultValue={r.name} /></div>
                  <div className="field"><label htmlFor={`s-${r.doctor_id}`}>Specialisation</label><input id={`s-${r.doctor_id}`} name="specialization" maxLength={120} defaultValue={r.specialization} /></div>
                </div>
                <div className="field"><label htmlFor={`o-${r.doctor_id}`}>Note for the desk</label><input id={`o-${r.doctor_id}`} name="notes" maxLength={300} defaultValue={notes(r.doctor_id)} /></div>
                <div className="row"><label className="check"><input type="checkbox" name="active" defaultChecked={r.active} />Active (offered at the desk)</label><span className="spacer" />
                  <SubmitButton className="btn btn-ghost btn-sm">Save</SubmitButton></div>
              </AdminForm>
            </li>))}</ul> : <Empty>—</Empty>}
        </Card>
      </div>
    </>
  );
}
