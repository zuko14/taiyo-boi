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

const PAGE = 50;

export default async function Catalog({ params, searchParams }: { params: Promise<{ eventId: string }>; searchParams: Promise<{ q?: string; cat?: string; show?: string; page?: string }> }) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm(eventId, 'catalogue.view');
  const base = `/e/${eventId}/admin/catalog`;
  const qs = (over: Record<string, string | undefined>) => {
    const u = new URLSearchParams(Object.entries({ q: sp.q, cat: sp.cat, show: sp.show, page: sp.page, ...over }).filter(([, v]) => v) as [string, string][]);
    return u.size ? `${base}?${u}` : base;
  };
  const back = qs({});                                    // edits return to the same filtered page
  const live = isLive(ctx.event.status);
  const edit = ctx.can('catalogue.edit');
  const canPrice = ctx.can('addon.price.edit');
  const [{ data: tests }, { data: services }, { data: map }, { data: prices }] = await Promise.all([
    ctx.supabase.from('test_catalog').select('*').eq('event_id', eventId).order('archived').order('location').order('display_name'),
    ctx.supabase.from('workflow_services').select('id, code, name, location, active').eq('event_id', eventId).order('name'),
    ctx.supabase.from('workflow_service_tests').select('test_id, service_id, completion_rule').eq('event_id', eventId),
    ctx.supabase.from('addon_prices').select('test_id, price_paise, created_at').eq('event_id', eventId).eq('active', true).order('created_at', { ascending: false }),
  ]);
  const priceOf = (id: string) => (prices ?? []).find((p) => p.test_id === id)?.price_paise;
  const svcOf = (id: string) => (map ?? []).find((m) => m.test_id === id);
  const all = (tests ?? []) as Test[];
  const categories = [...new Set(all.map((t) => t.category || 'Uncategorised'))].sort();
  const q = (sp.q ?? '').trim().toLowerCase();
  const show = sp.show ?? 'current';
  const filtered = all.filter((t) => (!q || `${t.code} ${t.display_name} ${t.category} ${t.lab_order_code ?? ''}`.toLowerCase().includes(q))
    && (!sp.cat || (t.category || 'Uncategorised') === sp.cat)
    && (show === 'all' || (show === 'archived' ? t.archived : show === 'unlinked' ? !svcOf(t.id) && !t.archived : !t.archived)));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const page = Math.min(pages, Math.max(1, Number(sp.page) || 1));
  const rows = filtered.slice((page - 1) * PAGE, page * PAGE);
  const unlinked = all.filter((t) => !t.archived && !svcOf(t.id)).length;

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
        <div className="field"><label>Done during which visit?</label><select name="service_id" defaultValue={t ? svcOf(t.id)?.service_id ?? '' : (services ?? []).find((s) => s.code === 'SAMPLE')?.id ?? ''}>
          <option value="">— not linked (cannot be queued) —</option>{(services ?? []).filter((s) => s.active || (t && svcOf(t.id)?.service_id === s.id)).map((s) => <option key={s.id} value={s.id}>{s.name} ({locationLabel(s.location)})</option>)}</select></div>
        <div className="field"><label>…or a new visit</label><input name="new_service" list="visits-catalog" maxLength={80} placeholder="e.g. Blood sample collection, X-Ray" /></div>
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
      <datalist id="visits-catalog"><option value="Blood sample collection" /><option value="X-Ray" /><option value="ECG" /><option value="BMD" /><option value="Body composition" /><option value="USG screening" /><option value="Ultrasound (USG)" /><option value="2D Echo" /></datalist>
      <PageHead title="Test catalogue" meta={ctx.event.settings.package_mode === 'female_male'
        ? "Brochure shorthand (B2, BT2, D) is kept as supplied. Edit names/codes only from the Lab Partner's approved catalogue."
        : 'All tests offered at this camp. Add them to packages on the Packages page; an add-on price makes a test purchasable by participants.'} />
      {!edit ? <div className="alert alert-info">Read-only: you do not have catalogue.edit.</div> : null}
      {edit ? (
        <details className="card" open={!all.length}><summary className="strong" style={{ cursor: 'pointer' }}>Bulk upload tests and prices (CSV)</summary>
          <p className="small text2">Columns: code, name, category, price_inr, location (event_day / walk_in), service. Blank code is generated from the name; blank service = Sample collection. Re-uploading the same codes updates names and prices — existing orders keep their old price.</p>
          <div className="row" style={{ marginBottom: 10 }}><a className="btn btn-ghost btn-sm" href={`/e/${eventId}/admin/catalog/template`}>Download template</a>
            <a className="btn btn-ghost btn-sm" href={`/e/${eventId}/admin/catalog/template?current=1`}>Export current catalogue</a></div>
          <p className="small muted" style={{ marginTop: 0 }}>Excel sheets work too (including the lab&apos;s MRP list with &ldquo;Test Description&rdquo; and &ldquo;MRP (INR)&rdquo; columns): open it in Excel and use File → Save As → CSV UTF-8. A price makes the test sellable; map tests to visits in the table below or via the service column. <Link href={`/e/${eventId}/admin/packages`}>Packages</Link> can then bundle them.</p>
          <CatalogImport action={importCatalog} eventId={eventId} back={back} live={live} existing={all.map((t) => t.code)} />
        </details>) : null}
      {edit ? <details className="card" open={!all.length}><summary className="strong" style={{ cursor: 'pointer' }}>Add a test</summary><div style={{ marginTop: 12 }}>{form()}</div></details> : null}
      <Card title={`Tests (${all.filter((t) => !t.archived).length})`} sub={unlinked ? <span><span className="badge red">{unlinked}</span> not linked to a visit — they cannot be queued. <Link href={qs({ show: 'unlinked', page: undefined })}>Show them</Link></span> : 'All tests are linked to a visit.'}>
        <form method="get" className="row" role="search" style={{ marginBottom: 12 }}>
          <input className="input" type="search" name="q" defaultValue={sp.q} placeholder="Search by name, code or category" aria-label="Search tests" style={{ flex: 2, minWidth: 180 }} />
          <select className="input" name="cat" defaultValue={sp.cat ?? ''} aria-label="Category" style={{ flex: 1, minWidth: 150 }}>
            <option value="">All categories ({categories.length})</option>{categories.map((c) => <option key={c} value={c}>{c} ({all.filter((t) => (t.category || 'Uncategorised') === c && !t.archived).length})</option>)}</select>
          <select className="input" name="show" defaultValue={show} aria-label="Status" style={{ width: 170 }}>
            <option value="current">Active & inactive</option><option value="unlinked">Not linked to a visit</option><option value="archived">Archived</option><option value="all">Everything</option></select>
          <button className="btn btn-solid btn-sm">Filter</button>{sp.q || sp.cat || sp.show ? <Link className="btn btn-ghost btn-sm" href={base}>Clear</Link> : null}
        </form>
        <p className="small muted" style={{ margin: '0 0 8px' }}>{filtered.length} test{filtered.length === 1 ? '' : 's'}{pages > 1 ? ` · page ${page} of ${pages}` : ''}</p>
        <div className="table-wrap"><table>
          <thead><tr><th>Test</th><th>Category</th><th>Visit</th><th>Price</th><th>Status</th><th></th></tr></thead>
          <tbody>{rows.map((t) => (
            <tr key={t.id}>
              <td><span className="strong">{t.display_name}</span><div className="mono small muted">{t.code}{t.source_wording && t.source_wording !== t.display_name ? ` · was “${t.source_wording}”` : ''}{t.location === 'walk_in' ? ' · walk-in' : ''}</div></td>
              <td className="small">{t.category || '—'}</td><td className="small">{(services ?? []).find((s) => s.id === svcOf(t.id)?.service_id)?.name ?? <span className="badge red">no visit — cannot be queued</span>}</td>
              <td>{priceOf(t.id) != null ? inr(priceOf(t.id)!) : '—'}{priceOf(t.id) != null && !t.addon_available ? <div className="small muted">not for sale</div> : null}</td><td><StatusBadge status={t.archived ? 'archived' : t.active ? 'active' : 'closed'} label={t.archived ? 'Archived' : t.active ? 'Active' : 'Inactive'} /></td>
              <td><details><summary className="btn btn-ghost btn-sm">Edit</summary><div style={{ width: 'min(760px, 86vw)', whiteSpace: 'normal', padding: '12px 0' }}>{form(t)}
                {edit ? <AdminForm action={deleteTest} eventId={eventId} back={back} live={live} hidden={{ id: t.id }} style={{ marginTop: 10 }}>
                  <SubmitButton className="btn btn-red btn-sm" confirm={`Delete ${t.display_name}? It is removed from every package and its add-on prices. Tests already ordered by participants cannot be deleted — archive them instead.`}>Delete test</SubmitButton>
                </AdminForm> : null}</div></details></td>
            </tr>))}
            {!rows.length ? <tr><td colSpan={6} className="muted">{all.length ? 'No test matches these filters.' : 'No tests yet — upload a CSV or add one above.'}</td></tr> : null}</tbody>
        </table></div>
        {pages > 1 ? (
          <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}>
            {page > 1 ? <Link className="btn btn-ghost btn-sm" href={qs({ page: String(page - 1) })}>← Previous</Link> : null}
            <span className="small muted">Page {page} of {pages}</span>
            {page < pages ? <Link className="btn btn-ghost btn-sm" href={qs({ page: String(page + 1) })}>Next →</Link> : null}
          </div>) : null}
      </Card>
    </>
  );
}
