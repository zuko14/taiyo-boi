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
  const has = new Set((rp ?? []).filter((r) => r.role_code === role).map((r) => r.permission_code));
  const ppl = (people ?? []) as { user_id: string; full_name: string }[];

  return (
    <>
      <PageHead title="Permissions" meta="Granular permissions are enforced in the database. Changes are audited." />
      <div className="grid grid-2">
        <Card title="Role permissions" sub={(roles ?? []).find((r) => r.code === role)?.description}>
          <form method="get" className="row" style={{ marginBottom: 14 }}>
            <select name="role" defaultValue={role} className="input" style={{ flex: 1 }} aria-label="Role">{(roles ?? []).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select>
            <button className="btn btn-ghost btn-sm">Show</button>
          </form>
          <AdminForm action={setRolePermissions} eventId={eventId} back={`${back}?role=${role}`} live={live} hidden={{ role }}>
            <div style={{ columns: 2, columnGap: 18 }}>{(perms ?? []).map((p) => (
              <label key={p.code} className="check small" title={p.description} style={{ breakInside: 'avoid' }}><input type="checkbox" name="perm" value={p.code} defaultChecked={has.has(p.code)} /><span className="mono">{p.code}</span></label>))}</div>
            <SubmitButton className="btn btn-solid" confirm="Save permissions for this role?">Save role permissions</SubmitButton>
          </AdminForm>
        </Card>
        <Card title="Individual grants and revokes" sub="Applied on top of a person's roles.">
          <AdminForm action={setOverride} eventId={eventId} back={back} live={live}>
            <div className="form-row">
              <div className="field"><label>Staff</label><select name="user_id" required>{ppl.map((p) => <option key={p.user_id} value={p.user_id}>{p.full_name}</option>)}</select></div>
              <div className="field"><label>Permission</label><select name="permission" required>{(perms ?? []).map((p) => <option key={p.code} value={p.code}>{p.code}</option>)}</select></div>
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
