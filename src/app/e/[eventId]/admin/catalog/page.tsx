import { AdminForm, isLive } from '@/components/AdminForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, PageHead, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { inr, locationLabel } from '@/lib/format';
import { deleteTest, importCatalog, saveTest } from '../actions';
import { CatalogImport } from '@/components/CatalogImport';
import Link from 'next/link';

type Test = { id: string; code: string; display_name: string; category: string; source_wording: string; lab_order_code: string | null; instructions: string;
  location: string; active: boolean; archived: boolean; addon_available: boolean };

export default async function Catalog({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await requirePerm(eventId, 'catalogue.view');
  const back = `/e/${eventId}/admin/catalog`;
  const live = isLive(ctx.event.status);
  const edit = ctx.can('catalogue.edit');
  const canPrice = ctx.can('addon.price.edit');
  const [{ data: tests }, { data: services }, { data: map }, { data: prices }] = await Promise.all([
    ctx.supabase.from('test_catalog').select('*').eq('event_id', eventId).order('archived').order('location').order('display_name'),
    ctx.supabase.from('workflow_services').select('id, name, location').eq('event_id', eventId).order('name'),
    ctx.supabase.from('workflow_service_tests').select('test_id, service_id, completion_rule').eq('event_id', eventId),
    ctx.supabase.from('addon_prices').select('test_id, price_paise, created_at').eq('event_id', eventId).eq('active', true).order('created_at', { ascending: false }),
  ]);
  const priceOf = (id: string) => (prices ?? []).find((p) => p.test_id === id)?.price_paise;
  const svcOf = (id: string) => (map ?? []).find((m) => m.test_id === id);

  const form = (t?: Test) => (
    <AdminForm action={saveTest} eventId={eventId} back={back} live={live} hidden={{ id: t?.id }}>
      <div className="form-row">
        <div className="field"><label>Code</label><input name="code" defaultValue={t?.code} required pattern="[A-Za-z0-9_\-]{1,40}" /></div>
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
      <div className="form-row">
        <div className="field" style={{ flex: 3 }}><label>Operational instructions</label><input name="instructions" defaultValue={t?.instructions} /></div>
        {canPrice ? <div className="field"><label>Add-on price (₹, employee-paid)</label><input name="price" inputMode="decimal" placeholder="optional"
          defaultValue={t && priceOf(t.id) != null ? String(priceOf(t.id)! / 100) : ''} /></div> : null}
      </div>
      <div className="row">
        <label className="check"><input type="checkbox" name="active" defaultChecked={t?.active ?? true} />Active</label>
        <label className="check"><input type="checkbox" name="addon_available" defaultChecked={t?.addon_available ?? false} />{ctx.event.settings.package_mode === 'female_male' ? 'Offer as add-on' : 'Sell to participants (registration & add-on desk)'}</label>
        <label className="check"><input type="checkbox" name="archived" defaultChecked={t?.archived ?? false} />Archived</label>
        <span className="spacer" />{edit ? <SubmitButton className="btn btn-solid btn-sm">{t ? 'Save' : 'Create test'}</SubmitButton> : null}
      </div>
    </AdminForm>
  );

  return (
    <>
      <PageHead title="Test catalogue" meta={ctx.event.settings.package_mode === 'female_male'
        ? "Brochure shorthand (B2, BT2, D) is kept as supplied. Edit names/codes only from the Lab Partner's approved catalogue."
        : 'All tests offered at this camp. Add them to packages on the Packages page; an add-on price makes a test purchasable by participants.'} />
      {!edit ? <div className="alert alert-info">Read-only: you do not have catalogue.edit.</div> : null}
      {edit ? (
        <Card title="Bulk upload tests and prices (CSV)" sub="Columns: code, name, category, price_inr, location (event_day / walk_in), service. Blank code is generated from the name; blank service = Sample collection. Re-uploading the same codes updates names and prices — existing orders keep their old price."
          actions={<div className="row"><a className="btn btn-ghost btn-sm" href={`/e/${eventId}/admin/catalog/template`}>Download template</a>
            <a className="btn btn-ghost btn-sm" href={`/e/${eventId}/admin/catalog/template?current=1`}>Export current catalogue</a></div>}>
          <p className="small muted" style={{ marginTop: 0 }}>Excel sheets work too (including the lab&apos;s MRP list with &ldquo;Test Description&rdquo; and &ldquo;MRP (INR)&rdquo; columns): open it in Excel and use File → Save As → CSV UTF-8. A price makes the test sellable; map tests to visits in the table below or via the service column. <Link href={`/e/${eventId}/admin/packages`}>Packages</Link> can then bundle them.</p>
          <CatalogImport action={importCatalog} eventId={eventId} back={back} live={live} existing={((tests ?? []) as Test[]).map((t) => t.code)} />
        </Card>) : null}
      <Card>
        <div className="table-wrap"><table>
          <thead><tr><th>Code</th><th>Name</th><th>Original wording</th><th>Location</th><th>Service</th><th>Add-on</th><th>Add-on price</th><th>Status</th><th></th></tr></thead>
          <tbody>{((tests ?? []) as Test[]).map((t) => (
            <tr key={t.id}>
              <td className="mono">{t.code}</td><td className="strong">{t.display_name}</td><td className="small muted">{t.source_wording}</td>
              <td>{locationLabel(t.location)}</td><td>{(services ?? []).find((s) => s.id === svcOf(t.id)?.service_id)?.name ?? <span className="badge red">unmapped</span>}</td>
              <td>{t.addon_available ? 'Yes' : '—'}</td><td>{priceOf(t.id) != null ? inr(priceOf(t.id)!) : '—'}</td><td><StatusBadge status={t.archived ? 'archived' : t.active ? 'active' : 'closed'} label={t.archived ? 'Archived' : t.active ? 'Active' : 'Inactive'} /></td>
              <td><details><summary className="btn btn-ghost btn-sm">Edit</summary><div style={{ width: 'min(760px, 86vw)', whiteSpace: 'normal', padding: '12px 0' }}>{form(t)}
                {edit ? <AdminForm action={deleteTest} eventId={eventId} back={back} live={live} hidden={{ id: t.id }} style={{ marginTop: 10 }}>
                  <SubmitButton className="btn btn-red btn-sm" confirm={`Delete ${t.display_name}? It is removed from every package and its add-on prices. Tests already ordered by participants cannot be deleted — archive them instead.`}>Delete test</SubmitButton>
                </AdminForm> : null}</div></details></td>
            </tr>))}</tbody>
        </table></div>
      </Card>
      {edit ? <Card title="Add a test">{form()}</Card> : null}
    </>
  );
}
