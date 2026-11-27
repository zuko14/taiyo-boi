import { AdminForm, isLive } from '@/components/AdminForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, PageHead } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { setOverride, setRolePermissions } from '../actions';

export default async function Permissions({ params, searchParams }: { params: Promise<{ eventId: string }>; searchParams: Promise<{ role?: string }> }) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm(eventId, 'permissions.manage');
  const back = `/e/${eventId}/admin/permissions`;
  const live = isLive(ctx.event.status);
  const [{ data: perms }, { data: roles }, { data: rp }, { data: overrides }, { data: people }] = await Promise.all([
    ctx.supabase.from('permissions').select('code, description').order('code'),
    ctx.supabase.from('roles').select('code, name, description').order('name'),
    ctx.supabase.from('role_permissions').select('role_code, permission_code').eq('event_id', eventId),
    ctx.supabase.from('member_permission_overrides').select('user_id, permission_code, granted').eq('event_id', eventId),
    ctx.supabase.rpc('staff_directory', { p_event: eventId }),
  ]);
  const role = sp.role ?? 'registration_staff';
  // group permission codes by the area of work they belong to
  const GROUPS: [string, RegExp][] = [['Registration desk', /^(registration|tag|choice)\./], ['Payments & extra tests', /^(payment|addon\.(create|discount))/],
    ['Stations & queue', /^(task|queue|station|shift|walkin)\./], ['Reports', /^report\./], ['Viewing & exports', /^(dashboard|participant|finance|sponsor|audit|export)\./],
    ['Setup (admins)', /./]];
  const groupOf = (code: string) => GROUPS.find(([, re]) => re.test(code))![0];
  const holders = (((await ctx.supabase.from('event_memberships').select('user_id').eq('event_id', eventId).eq('role_code', role).eq('active', true)).data ?? []) as { user_id: string }[])
    .map((m) => ((people ?? []) as { user_id: string; full_name: string }[]).find((p) => p.user_id === m.user_id)?.full_name).filter(Boolean);
  const has = new Set((rp ?? []).filter((r) => r.role_code === role).map((r) => r.permission_code));
  const ppl = (people ?? []) as { user_id: string; full_name: string }[];

  return (
    <>
      <PageHead title="Permissions" meta="A person can hold several roles; they can do everything any of their roles allows. Changes apply immediately to everyone with the role, are enforced by the database, and are audited." />
      <div className="grid grid-2">
        <Card title="What each role can do" sub={<>{(roles ?? []).find((r) => r.code === role)?.description}<div className="small muted" style={{ marginTop: 4 }}>Held by: {holders.length ? holders.join(', ') : 'nobody yet'}</div></>}>
          <form method="get" className="row" style={{ marginBottom: 14 }}>
            <select name="role" defaultValue={role} className="input" style={{ flex: 1 }} aria-label="Role">{(roles ?? []).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select>
            <button className="btn btn-ghost btn-sm">Show</button>
          </form>
          <AdminForm action={setRolePermissions} eventId={eventId} back={`${back}?role=${role}`} live={live} hidden={{ role }}>
            {GROUPS.map(([g]) => { const list = (perms ?? []).filter((p) => groupOf(p.code) === g); return list.length ? (
              <fieldset key={g} style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
                <legend className="label" style={{ marginBottom: 6 }}>{g}</legend>
                <div style={{ columns: 2, columnGap: 18 }}>{list.map((p) => (
                  <label key={p.code} className="check small" style={{ breakInside: 'avoid', alignItems: 'flex-start' }}><input type="checkbox" name="perm" value={p.code} defaultChecked={has.has(p.code)} />
                    <span>{p.description}<span className="mono muted" style={{ display: 'block', fontSize: '0.7rem' }}>{p.code}</span></span></label>))}</div>
              </fieldset>) : null; })}
            <SubmitButton className="btn btn-solid" confirm="Save permissions for this role?">Save role permissions</SubmitButton>
          </AdminForm>
        </Card>
        <Card title="Individual grants and revokes" sub="Applied on top of a person's roles.">
          <AdminForm action={setOverride} eventId={eventId} back={back} live={live}>
            <div className="form-row">
              <div className="field"><label>Staff</label><select name="user_id" required>{ppl.map((p) => <option key={p.user_id} value={p.user_id}>{p.full_name}</option>)}</select></div>
              <div className="field"><label>Permission</label><select name="permission" required>{(perms ?? []).map((p) => <option key={p.code} value={p.code}>{p.description} ({p.code})</option>)}</select></div>
              <div className="field"><label>Action</label><select name="mode"><option value="grant">Grant</option><option value="revoke">Revoke</option><option value="remove">Remove override</option></select></div>
            </div>
            <SubmitButton className="btn btn-ghost">Apply</SubmitButton>
          </AdminForm>
          <ul className="list" style={{ marginTop: 14 }}>{(overrides ?? []).map((o, i) => (
            <li key={i}><span>{ppl.find((p) => p.user_id === o.user_id)?.full_name} · <span className="mono small">{o.permission_code}</span></span><span className={`badge ${o.granted ? 'green' : 'red'}`}>{o.granted ? 'granted' : 'revoked'}</span></li>))}
            {!overrides?.length ? <li className="muted">No individual overrides.</li> : null}</ul>
        </Card>
      </div>
    </>
  );
}
