import { AdminForm } from '@/components/AdminForm';
import { RpcForm } from '@/components/RpcForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, PageHead, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { nowMs } from '@/lib/clock';
import { dt, isoToLocalInput } from '@/lib/format';
import { addRole, createStaff, setMembershipActive } from '../actions';

export default async function Staff({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await requirePerm(eventId, 'staff.manage', 'shift.assign');
  const tz = ctx.event.timezone;
  const back = `/e/${eventId}/admin/staff`;
  const [{ data: people }, { data: members }, { data: roles }, { data: stations }, { data: shifts }] = await Promise.all([
    ctx.supabase.rpc('staff_directory', { p_event: eventId }),
    ctx.supabase.from('event_memberships').select('id, user_id, role_code, active').eq('event_id', eventId),
    ctx.supabase.from('roles').select('code, name').order('name'),
    ctx.supabase.from('stations').select('id, code, name, kind').eq('event_id', eventId).order('code'),
    ctx.supabase.from('staff_assignments').select('id, user_id, station_id, shift_start, shift_end, status').eq('event_id', eventId).order('shift_start', { ascending: false }).limit(300),
  ]);
  type Person = { user_id: string; full_name: string; email: string; roles: string[] };
  const ppl = (people ?? []) as Person[];
  const name = (id: string) => ppl.find((p) => p.user_id === id)?.full_name ?? id.slice(0, 8);
  const st = (id: string) => (stations ?? []).find((s) => s.id === id)?.name ?? '?';
  const now = nowMs();
  const startDefault = isoToLocalInput(new Date().toISOString(), tz);
  const endDefault = isoToLocalInput(new Date(now + 8 * 3600_000).toISOString(), tz);

  return (
    <>
      <PageHead title="Staff & shifts" meta="Staff need an event role and an active shift at their counter/station. Shift history is kept." />
      <Card title="Assign a shift">
        <RpcForm eventId={eventId} rpc="assign_staff" back={back} ok="Shift assigned">
          <div className="form-row">
            <div className="field"><label>Staff member</label><select name="p_user" required>{ppl.map((p) => <option key={p.user_id} value={p.user_id}>{p.full_name} · {p.roles.join(', ')}</option>)}</select></div>
            <div className="field"><label>Counter / station</label><select name="p_station" required>{(stations ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.kind.replace('_', ' ')})</option>)}</select></div>
            <div className="field"><label>Shift start</label><input type="datetime-local" name="p_start_local" required defaultValue={startDefault} /></div>
            <div className="field"><label>Shift end</label><input type="datetime-local" name="p_end_local" required defaultValue={endDefault} /></div>
          </div>
          <SubmitButton>Assign shift</SubmitButton>
        </RpcForm>
      </Card>
      <Card title="Shifts">
        <div className="table-wrap"><table><thead><tr><th>Staff</th><th>Station</th><th>Start</th><th>End</th><th>Status</th><th></th></tr></thead>
          <tbody>{(shifts ?? []).map((s) => {
            const on = s.status === 'active' && new Date(s.shift_start).getTime() <= now && new Date(s.shift_end).getTime() >= now;
            return (
              <tr key={s.id}><td>{name(s.user_id)}</td><td>{st(s.station_id)}</td><td>{dt(s.shift_start, tz)}</td><td>{dt(s.shift_end, tz)}</td>
                <td><StatusBadge status={s.status === 'ended' ? 'ended' : on ? 'active' : 'pending'} label={s.status === 'ended' ? 'Ended' : on ? 'On shift' : 'Scheduled / expired'} /></td>
                <td>{s.status === 'active' ? <RpcForm eventId={eventId} rpc="end_staff_assignment" back={back} ok="Shift ended" hidden={{ p_assignment: s.id }}><SubmitButton className="btn btn-ghost btn-sm">End shift</SubmitButton></RpcForm> : null}</td></tr>);
          })}</tbody></table></div>
      </Card>
      {ctx.can('staff.manage') ? (
        <div className="grid grid-2">
          <Card title="Create staff account" sub="Use the person's work email. Share the initial password privately.">
            <AdminForm action={createStaff} eventId={eventId} back={back} live={false}>
              <div className="field"><label>Full name</label><input name="full_name" required /></div>
              <div className="field"><label>Email</label><input name="email" type="email" required /></div>
              <div className="field"><label>Initial password (min 12 characters)</label><input name="password" type="password" minLength={12} required autoComplete="new-password" /></div>
              <div className="field"><label>Role</label><select name="role" required>{(roles ?? []).filter((r) => r.code !== 'event_admin' || ctx.can('permissions.manage')).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select></div>
              <SubmitButton>Create account</SubmitButton>
            </AdminForm>
          </Card>
          <Card title="Staff and roles">
            <ul className="list">{ppl.map((p) => (
              <li key={p.user_id} style={{ display: 'block' }}>
                <div className="row-between"><span><span className="strong">{p.full_name}</span> <span className="small muted">{p.email}</span></span></div>
                <div className="row" style={{ marginTop: 6 }}>
                  {(members ?? []).filter((m) => m.user_id === p.user_id).map((m) => (
                    <AdminForm key={m.id} action={setMembershipActive} eventId={eventId} back={back} live={false} hidden={{ id: m.id, active: m.active ? 'false' : 'true' }} className="row">
                      <span className={`badge ${m.active ? 'green' : ''}`}>{m.role_code.replace(/_/g, ' ')}</span>
                      {m.user_id !== ctx.user.id ? <button className="btn btn-ghost btn-sm">{m.active ? 'Deactivate' : 'Reactivate'}</button> : null}
                    </AdminForm>))}
                  <AdminForm action={addRole} eventId={eventId} back={back} live={false} hidden={{ user_id: p.user_id }} className="row">
                    <select name="role" className="input" style={{ width: 170, padding: '6px 10px' }} aria-label="Add role">{(roles ?? []).filter((r) => r.code !== 'event_admin' || ctx.can('permissions.manage')).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select>
                    <button className="btn btn-ghost btn-sm">Add role</button>
                  </AdminForm>
                </div>
              </li>))}</ul>
          </Card>
        </div>) : null}
    </>
  );
}
