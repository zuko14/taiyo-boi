import { AdminForm, isLive } from '@/components/AdminForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, PageHead, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { locationLabel } from '@/lib/format';
import { saveTest } from '../actions';

type Test = { id: string; code: string; display_name: string; category: string; source_wording: string; lab_order_code: string | null; instructions: string;
  location: string; active: boolean; archived: boolean; addon_available: boolean };

export default async function Catalog({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await requirePerm(eventId, 'catalogue.view');
  const back = `/e/${eventId}/admin/catalog`;
  const live = isLive(ctx.event.status);
  const edit = ctx.can('catalogue.edit');
  const [{ data: tests }, { data: services }, { data: map }] = await Promise.all([
    ctx.supabase.from('test_catalog').select('*').eq('event_id', eventId).order('archived').order('location').order('display_name'),
    ctx.supabase.from('workflow_services').select('id, name, location').eq('event_id', eventId).order('name'),
    ctx.supabase.from('workflow_service_tests').select('test_id, service_id, completion_rule').eq('event_id', eventId),
  ]);
  const svcOf = (id: string) => (map ?? []).find((m) => m.test_id === id);

  const form = (t?: Test) => (
    <AdminForm action={saveTest} eventId={eventId} back={back} live={live} hidden={{ id: t?.id }}>
      <div className="form-row">
        <div className="field"><label>Code</label><input name="code" defaultValue={t?.code} required pattern="[A-Za-z0-9_-]{1,40}" /></div>
        <div className="field"><label>Display name</label><input name="display_name" defaultValue={t?.display_name} required /></div>
        <div className="field"><label>Lab Partner order code</label><input name="lab_order_code" defaultValue={t?.lab_order_code ?? ''} /></div>
        <div className="field"><label>Category</label><input name="category" defaultValue={t?.category} /></div>
      </div>
      <div className="form-row">
        <div className="field"><label>Performed at</label><select name="location" defaultValue={t?.location ?? 'event_day'}><option value="event_day">Event day</option><option value="walk_in">Walk-in centre</option></select></div>
        <div className="field"><label>Workflow service (physical visit)</label><select name="service_id" defaultValue={t ? svcOf(t.id)?.service_id ?? '' : ''}>
          <option value="">— not mapped —</option>{(services ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} ({locationLabel(s.location)})</option>)}</select></div>
        <div className="field"><label>Attendance on service completion</label><select name="completion_rule" defaultValue={t ? svcOf(t.id)?.completion_rule ?? 'fulfilled_on_complete' : 'fulfilled_on_complete'}>
          <option value="fulfilled_on_complete">Recorded when the service is completed</option><option value="manual_confirm">Confirm this test separately</option></select></div>
      </div>
      <div className="field"><label>Operational instructions</label><input name="instructions" defaultValue={t?.instructions} /></div>
      <div className="row">
        <label className="check"><input type="checkbox" name="active" defaultChecked={t?.active ?? true} />Active</label>
        <label className="check"><input type="checkbox" name="addon_available" defaultChecked={t?.addon_available ?? false} />Offer as add-on</label>
        <label className="check"><input type="checkbox" name="archived" defaultChecked={t?.archived ?? false} />Archived</label>
        <span className="spacer" />{edit ? <SubmitButton className="btn btn-solid btn-sm">{t ? 'Save' : 'Create test'}</SubmitButton> : null}
      </div>
    </AdminForm>
  );

  return (
    <>
      <PageHead title="Test catalogue" meta="Brochure shorthand (B2, BT2, D) is kept as supplied. Edit names/codes only from the Lab Partner's approved catalogue." />
      {!edit ? <div className="alert alert-info">Read-only: you do not have catalogue.edit.</div> : null}
      <Card>
        <div className="table-wrap"><table>
          <thead><tr><th>Code</th><th>Name</th><th>Original wording</th><th>Location</th><th>Service</th><th>Add-on</th><th>Status</th><th></th></tr></thead>
          <tbody>{((tests ?? []) as Test[]).map((t) => (
            <tr key={t.id}>
              <td className="mono">{t.code}</td><td className="strong">{t.display_name}</td><td className="small muted">{t.source_wording}</td>
              <td>{locationLabel(t.location)}</td><td>{(services ?? []).find((s) => s.id === svcOf(t.id)?.service_id)?.name ?? <span className="badge red">unmapped</span>}</td>
              <td>{t.addon_available ? 'Yes' : '—'}</td><td><StatusBadge status={t.archived ? 'archived' : t.active ? 'active' : 'closed'} label={t.archived ? 'Archived' : t.active ? 'Active' : 'Inactive'} /></td>
              <td><details><summary className="btn btn-ghost btn-sm">Edit</summary><div style={{ width: 760, whiteSpace: 'normal', padding: '12px 0' }}>{form(t)}</div></details></td>
            </tr>))}</tbody>
        </table></div>
      </Card>
      {edit ? <Card title="Add a test">{form()}</Card> : null}
    </>
  );
}
