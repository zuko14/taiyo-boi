import { AdminForm, isLive } from '@/components/AdminForm';
import { RpcForm } from '@/components/RpcForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, PageHead, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { nowMs } from '@/lib/clock';
import { dt, isoToLocalInput } from '@/lib/format';
import { addRole, createStaff, resetStaffPassword, setMembershipActive } from '../actions';

export default async function Staff({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await requirePerm(eventId, 'staff.manage', 'shift.assign');
  const tz = ctx.event.timezone;
  const back = `/e/${eventId}/admin/staff`;
  const live = isLive(ctx.event.status);
  const [{ data: people }, { data: members }, { data: roles }, { data: stations }, { data: shifts }, { data: caps }] = await Promise.all([
    ctx.supabase.rpc('staff_directory', { p_event: eventId }),
    ctx.supabase.from('event_memberships').select('id, user_id, role_code, active').eq('event_id', eventId),
    ctx.supabase.from('roles').select('code, name').order('name'),
    ctx.supabase.from('stations').select('id, code, name, kind').eq('event_id', eventId).order('code'),
    ctx.supabase.from('staff_assignments').select('id, user_id, station_id, shift_start, shift_end, status').eq('event_id', eventId).order('shift_start', { ascending: false }).limit(300),
    ctx.supabase.from('station_capabilities').select('station_id, workflow_services(name)').eq('event_id', eventId),
  ]);
  type Person = { user_id: string; full_name: string; email: string; roles: string[] };
  const roleName = (code: string) => (roles ?? []).find((r) => r.code === code)?.name ?? code.replace(/_/g, ' ');
  const does = (stationId: string, kind: string) => {
    const v = (caps ?? []).filter((c) => c.station_id === stationId).map((c) => (c.workflow_services as unknown as { name: string }).name);
    return v.length ? v.join(', ') : ({ registration_counter: 'registration', addon_desk: 'add-on / payment desk', station: 'no visit set', walkin_centre: 'walk-in centre' } as Record<string, string>)[kind] ?? kind;
  };
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
        <RpcForm eventId={eventId} rpc="assign_staff" back={back} ok="Shift assigned — the right access for that station was given automatically">
          <div className="form-row">
            <div className="field"><label>Staff member</label><select name="p_user" required>{ppl.map((p) => <option key={p.user_id} value={p.user_id}>{p.full_name} · {p.roles.map(roleName).join(', ')}</option>)}</select></div>
            <div className="field"><label>Counter / station</label><select name="p_station" required>{([['station', 'Diagnostic stations'], ['registration_counter', 'Registration counters'], ['addon_desk', 'Add-on / payment desks'], ['walkin_centre', 'Walk-in centres']] as const).map(([k, label]) => {
              const list = (stations ?? []).filter((s) => s.kind === k); return list.length ? <optgroup key={k} label={label}>{list.map((s) => <option key={s.id} value={s.id}>{s.name} — {does(s.id, s.kind)}</option>)}</optgroup> : null; })}</select>
              <span className="help">The shift decides where the person works and what they see. If they don&apos;t already have it, they automatically get the role that station needs (blood collection → Phlebotomist, X-Ray / Ultrasound / 2D Echo → radiology technician, registration → Registration Desk, and Cashier where patients pay).</span></div>
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
            <AdminForm action={createStaff} eventId={eventId} back={back} live={live}>
              <div className="field"><label>Full name</label><input name="full_name" required /></div>
              <div className="field"><label>Email</label><input name="email" type="email" required /></div>
              <div className="field"><label>Initial password (min 12 characters)</label><input name="password" type="password" minLength={12} required autoComplete="new-password" /></div>
              <div className="field"><label>Role</label><select name="role" required>{(roles ?? []).filter((r) => r.code !== 'event_admin' || ctx.can('permissions.manage')).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select></div>
              <SubmitButton>Create account</SubmitButton>
            </AdminForm>
          </Card>
          {/* role add/remove: the server records a standard audit reason, so no per-row reason box */}
          <Card title="Staff and roles">
            <ul className="list">{ppl.map((p) => (
              <li key={p.user_id} style={{ display: 'block' }}>
                <div className="row-between"><span><span className="strong">{p.full_name}</span> <span className="small muted">{p.email}</span></span></div>
                <div className="row" style={{ marginTop: 6 }}>
                  {(members ?? []).filter((m) => m.user_id === p.user_id).map((m) => (
                    <AdminForm key={m.id} action={setMembershipActive} eventId={eventId} back={back} live={false} hidden={{ id: m.id, active: m.active ? 'false' : 'true' }} className="row">
                      <span className={`badge ${m.active ? 'green' : ''}`} style={m.active ? undefined : { textDecoration: 'line-through' }}>{roleName(m.role_code)}</span>
                      {m.user_id !== ctx.user.id ? <button className="btn btn-ghost btn-sm" aria-label={`${m.active ? 'Remove' : 'Restore'} ${roleName(m.role_code)} for ${p.full_name}`}>{m.active ? 'Remove' : 'Restore'}</button> : null}
                    </AdminForm>))}
                  <AdminForm action={addRole} eventId={eventId} back={back} live={false} hidden={{ user_id: p.user_id }} className="row">
                    <select name="role" className="input" style={{ width: 220, padding: '6px 10px' }} aria-label={`Add a role for ${p.full_name}`}>{(roles ?? []).filter((r) => (r.code !== 'event_admin' || ctx.can('permissions.manage'))
                      && !(members ?? []).some((m) => m.user_id === p.user_id && m.role_code === r.code && m.active)).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select>
                    <button className="btn btn-ghost btn-sm">Add role</button>
                  </AdminForm>
                </div>
                <details style={{ marginTop: 8 }}>
                  <summary className="small text2" style={{ cursor: 'pointer' }}>Reset password (forgot password)</summary>
                  <AdminForm action={resetStaffPassword} eventId={eventId} back={back} live={live} hidden={{ user_id: p.user_id }} style={{ marginTop: 8 }}>
                    <div className="form-row">
                      <div className="field"><label htmlFor={`pw-${p.user_id}`}>New password (min 12 characters)</label>
                        <input id={`pw-${p.user_id}`} name="password" type="password" minLength={12} required autoComplete="new-password" /></div>
                      <div className="field"><label htmlFor={`pw2-${p.user_id}`}>Type it again</label>
                        <input id={`pw2-${p.user_id}`} name="password_confirm" type="password" minLength={12} required autoComplete="new-password" /></div>
                    </div>
                    <SubmitButton className="btn btn-ghost btn-sm" confirm={`Set a new password for ${p.full_name}? Their old password stops working.`}>Set new password</SubmitButton>
                    <p className="small muted" style={{ margin: '6px 0 0' }}>They sign in with <strong>{p.email}</strong> and the new password. Tell them in person or by phone — not in a group chat.</p>
                  </AdminForm>
                </details>
              </li>))}</ul>
          </Card>
        </div>) : null}
    </>
  );
}
