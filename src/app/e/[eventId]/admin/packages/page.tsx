import { AdminForm, isLive } from '@/components/AdminForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, PageHead } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import Link from 'next/link';
import { classLabel, locationLabel, priceWithDiscount } from '@/lib/format';
import { PackageTestPicker } from '@/components/PackageTestPicker';
import { PackagesImport } from '@/components/PackagesImport';
import { importPackages, addNewTestToPackage, addPackageTest, setPackageTests, createPackage, deletePackage, removePackageTest, saveChoiceGroup, savePackage, savePackageTest, saveService, setPackageRate } from '../actions';

type Svc = { id: string; code: string; name: string; location: string; priority: number; est_minutes: number | null; instructions: string; active: boolean };

export default async function Packages({ params, searchParams }: { params: Promise<{ eventId: string }>; searchParams: Promise<{ pkg?: string; q?: string }> }) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm(eventId, 'package.view');
  const base = `/e/${eventId}/admin/packages`;
  const back = sp.pkg ? `${base}?pkg=${encodeURIComponent(sp.pkg)}` : base;   // actions return to the open package
  const live = isLive(ctx.event.status);
  const canPkg = ctx.can('package.edit'); const canMap = ctx.can('package.test_mapping.edit');
  const custom = (ctx.event.settings.package_mode ?? 'custom') !== 'female_male';
  const [{ data: pkgs }, { data: pts }, { data: tests }, { data: groups }, { data: services }, { data: map }, { data: checks }] = await Promise.all([
    ctx.supabase.from('packages').select('*').eq('event_id', eventId).order('classification'),
    ctx.supabase.from('package_tests').select('*').eq('event_id', eventId),
    ctx.supabase.from('test_catalog').select('id, code, display_name, category, location, active, archived').eq('event_id', eventId).order('category').order('display_name'),
    ctx.supabase.from('choice_groups').select('*').eq('event_id', eventId),
    ctx.supabase.from('workflow_services').select('*').eq('event_id', eventId).order('location').order('priority').order('name'),
    ctx.supabase.from('workflow_service_tests').select('test_id, service_id').eq('event_id', eventId),
    ctx.supabase.rpc('validate_event', { p_event: eventId }),
  ]);
  const { data: prices } = await ctx.supabase.from('addon_prices').select('test_id, price_paise, created_at').eq('event_id', eventId).eq('active', true).order('created_at', { ascending: false });
  const test = (id: string) => (tests ?? []).find((t) => t.id === id);
  const svcName = (id?: string) => (services ?? []).find((s) => s.id === id)?.name;
  const svcOfTest = (id: string) => (map ?? []).find((m) => m.test_id === id)?.service_id;
  const q = (sp.q ?? '').trim().toLowerCase();
  const listed = (pkgs ?? []).filter((p) => !q || `${p.name} ${p.code}`.toLowerCase().includes(q))
    .sort((a, b) => Number(a.code === 'PAY_PER_TEST') - Number(b.code === 'PAY_PER_TEST') || a.name.localeCompare(b.name));

  return (
    <>
      <datalist id="visits-pkg"><option value="Blood sample collection" /><option value="ECG" /><option value="X-Ray" /><option value="Ultrasound (USG)" /><option value="2D Echo" /><option value="BMD" /><option value="Body composition" /></datalist>
      <PageHead title="Packages & services" meta={custom
        ? 'Create the packages offered at this camp, choose their tests and set prices. Changes apply to new registrations; existing ones keep their snapshot.'
        : 'Exactly two sponsored packages (Female / Male). Changes apply to new registrations; existing ones keep their snapshot.'}>
        <Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/admin/catalog`}>Test catalogue</Link>
        {ctx.can('addon.price.edit') ? <Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/admin/prices`}>Add-on prices</Link> : null}
      </PageHead>
      {!sp.pkg ? (<>
      <Card title={`Packages (${(pkgs ?? []).filter((p) => p.code !== 'PAY_PER_TEST').length})`} sub="Open a package to choose its tests, price and details."
        actions={<form method="get" className="row" role="search"><input className="input" name="q" defaultValue={sp.q} placeholder="Search packages" aria-label="Search packages" style={{ width: 200, padding: '7px 12px' }} /><button className="btn btn-ghost btn-sm">Search</button></form>}>
        {listed.length ? (
          <div className="table-wrap"><table><thead><tr><th>Package</th><th>Tests</th><th>Queue stops</th><th>Price</th><th>Status</th><th></th></tr></thead>
            <tbody>{listed.map((p) => { const n = (pts ?? []).filter((x) => x.package_id === p.id); const stops = new Set(n.map((x) => svcOfTest(x.test_id) ?? 'none')); return (
              <tr key={p.id}><td><Link className="strong" href={`${base}?pkg=${p.id}`}>{p.name}</Link><div className="mono small muted">{p.code} · letter {p.code_letter}</div></td>
                <td>{p.code === 'PAY_PER_TEST' ? <span className="muted small">picked at the desk</span> : n.length || <span className="badge red">none</span>}</td>
                <td className="small">{p.code === 'PAY_PER_TEST' ? '—' : stops.size}</td>
                <td>{!custom ? 'Sponsored' : p.price_paise ? priceWithDiscount(p.price_paise, p.mrp_paise, p.discount_pct) : 'Free'}</td>
                <td>{p.active ? <span className="badge green">Active</span> : <span className="badge">Inactive</span>}</td>
                <td><Link className="btn btn-ghost btn-sm" href={`${base}?pkg=${p.id}`}>Open</Link></td></tr>); })}</tbody></table></div>
        ) : <p className="muted small">{sp.q ? `No package matches “${sp.q}”.` : 'No packages yet.'}</p>}
      </Card>
      {custom && canPkg ? (
        <details className="card" open={!(pkgs ?? []).length}><summary className="strong" style={{ cursor: 'pointer' }}>Create a package</summary>
        <div style={{ marginTop: 12 }}>
          <AdminForm action={createPackage} eventId={eventId} back={back} live={live}>
            <div className="form-row">
              <div className="field" style={{ flex: 2 }}><label>Package name</label><input name="name" required maxLength={120} placeholder="e.g. Executive Health Check" /></div>
              <div className="field"><label>Package code</label><input name="code" required pattern="[A-Za-z0-9_]{1,30}" placeholder="EXEC" title="Letters, digits and _ only" /></div>
              <div className="field"><label>Code letter (in registration codes)</label><input name="code_letter" required pattern="[A-Za-z]{1,3}" maxLength={3} placeholder="E" /></div>
            </div>
            <div className="field"><label>Description</label><input name="description" /></div>
            <SubmitButton className="btn btn-solid btn-sm">Create package</SubmitButton>
          </AdminForm>
        </div></details>) : null}
      {custom && canPkg && canMap ? (
        <details className="card"><summary className="strong" style={{ cursor: 'pointer' }}>Import packages from CSV</summary>
          <div style={{ marginTop: 12 }}>
            <p className="small muted" style={{ marginTop: 0 }}>One row per test: <span className="mono">package_code, package_name, code_letter, price_inr, description, test</span>. A test cell may list several tests separated by <span className="mono">;</span>. Tests are matched by catalogue code or exact name. Each package in the file gets exactly the tests listed; packages not in the file are untouched.</p>
            <div className="row" style={{ marginBottom: 10 }}>
              <a className="btn btn-ghost btn-sm" href={`${base}/template`}>Download template</a>
              <a className="btn btn-ghost btn-sm" href={`${base}/template?current=1`}>Export current packages</a></div>
            <PackagesImport action={importPackages} eventId={eventId} back={base} live={live} existing={(pkgs ?? []).map((p) => p.code)} />
          </div>
        </details>) : null}
      </>) : <div className="row" style={{ marginBottom: 12 }}><Link className="btn btn-ghost btn-sm" href={base}>← All packages</Link></div>}
      {(checks ?? []).filter((c: { level: string }) => c.level === 'error').map((c: { message: string }, i: number) => <div key={i} className="alert alert-err">{c.message}</div>)}
      {(pkgs ?? []).filter((p) => p.id === sp.pkg).map((p) => {
        const lines = (pts ?? []).filter((x) => x.package_id === p.id);
        const plain = lines.filter((x) => !x.choice_group_id);
        const pg = (groups ?? []).filter((g) => g.package_id === p.id);
        const plan = new Map<string, string[]>();
        for (const l of plain) { const k = svcName(svcOfTest(l.test_id)) ?? 'UNMAPPED'; plan.set(k, [...(plan.get(k) ?? []), test(l.test_id)?.display_name ?? '?']); }
        for (const g of pg) plan.set(`${svcName(g.service_id)} (choice: ${g.name})`, lines.filter((l) => l.choice_group_id === g.id).map((l) => test(l.test_id)?.display_name ?? '?'));
        if (p.code === 'PAY_PER_TEST') return (
          <Card key={p.id} title={`${p.name} · automatic`} sub={`Used for patients who register for individual tests only. It has no tests of its own and is always free — patients pay for exactly the tests picked at the desk. Registration codes use letter “${p.code_letter}”.`}>
            <AdminForm action={savePackage} eventId={eventId} back={back} live={live} hidden={{ id: p.id, description: p.description, eligibility_note: p.eligibility_note, active: p.active ? 'on' : undefined }} className="row" style={{ alignItems: 'flex-end' }}>
              <div className="field" style={{ marginBottom: 0 }}><label>Name</label><input name="name" defaultValue={p.name} required /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Code letter</label><input name="code_letter" defaultValue={p.code_letter} pattern="[A-Za-z]{1,3}" required /></div>
              {canPkg ? <SubmitButton className="btn btn-ghost btn-sm">Save</SubmitButton> : null}
            </AdminForm>
          </Card>);
        const pickTests = (tests ?? []).filter((t) => (t.active && !t.archived) || lines.some((l) => l.test_id === t.id)).map((t) => ({
          id: t.id, name: t.display_name, category: t.category, walkIn: t.location === 'walk_in', visit: svcName(svcOfTest(t.id)) ?? null,
          price_paise: (prices ?? []).find((x) => x.test_id === t.id)?.price_paise ?? null }));
        return (
          <Card key={p.id} title={custom ? `${p.name} · ${p.code}` : `${classLabel(p.classification)} · ${p.name}`}
            sub={`Registration codes use letter “${p.code_letter}”. ${custom ? (p.price_paise ? `Participant pays ${priceWithDiscount(p.price_paise, p.mrp_paise, p.discount_pct)} (collected at registration).` : 'Free for the participant.') : 'Employee charge: ₹0.'}${!p.active ? ' Inactive.' : ''}`}>
            <div className="grid grid-2">
              <div>
                <div className="label" style={{ marginBottom: 8 }}>Task plan preview (one queue stop per service)</div>
                <ul className="list">{[...plan.entries()].map(([k, v]) => (
                  <li key={k} style={{ display: 'block' }}><span className={k === 'UNMAPPED' ? 'badge red' : 'strong'}>{k}</span><div className="small text2">{v.join(', ')}</div></li>))}</ul>
                <AdminForm action={savePackage} eventId={eventId} back={back} live={live} hidden={{ id: p.id }} style={{ marginTop: 16 }}>
                  <div className="form-row">
                    <div className="field"><label>Name</label><input name="name" defaultValue={p.name} required /></div>
                    <div className="field"><label>Code letter</label><input name="code_letter" defaultValue={p.code_letter} pattern="[A-Za-z]{1,3}" required /></div>
                  </div>
                  <div className="field"><label>Description</label><input name="description" defaultValue={p.description} /></div>
                  <div className="field"><label>Eligibility rule (from Lab Partner)</label><input name="eligibility_note" defaultValue={p.eligibility_note} /></div>
                  <label className="check"><input type="checkbox" name="active" defaultChecked={p.active} />Active</label>
                  {canPkg ? <SubmitButton className="btn btn-ghost btn-sm">Save package</SubmitButton> : null}
                </AdminForm>
                {custom && canPkg ? (<>
                  <AdminForm action={setPackageRate} eventId={eventId} back={back} live={live} hidden={{ id: p.id }} className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
                    <div className="field" style={{ flex: 1, marginBottom: 0 }}><label>Package price (₹, blank or 0 = free)</label>
                      <input name="price" inputMode="decimal" placeholder="free" defaultValue={p.mrp_paise ?? p.price_paise ? String((p.mrp_paise ?? p.price_paise) / 100) : ''} /></div>
                    <div className="field" style={{ width: 130, marginBottom: 0 }}><label>Discount %</label>
                      <input name="discount_pct" inputMode="decimal" placeholder="0" defaultValue={Number(p.discount_pct) ? String(Number(p.discount_pct)) : ''} /></div>
                    <SubmitButton className="btn btn-ghost btn-sm">Save price</SubmitButton>
                  </AdminForm>
                  <AdminForm action={deletePackage} eventId={eventId} back={back} live={live} hidden={{ id: p.id }} style={{ marginTop: 12 }}>
                    <SubmitButton className="btn btn-red btn-sm" confirm={`Delete package ${p.name}? Only possible while nobody is registered on it.`}>Delete package</SubmitButton>
                  </AdminForm>
                </>) : null}
              </div>
              <div>
                <div className="label" style={{ marginBottom: 8 }}>Package tests</div>
                <ul className="list">{plain.map((l) => { const t = test(l.test_id); return (
                  <li key={l.id} style={{ display: 'block' }}>
                    <details><summary className="row-between" style={{ cursor: 'pointer' }}><span>{t?.display_name} <span className="small muted">· {locationLabel(t?.location ?? '')}{l.fasting_required ? ' · fasting' : ''}{l.depends_on_test_ids.length ? ' · has dependency' : ''}</span></span><span className="small muted">priority {l.priority}</span></summary>
                      {canMap ? (<>
                        <AdminForm action={savePackageTest} eventId={eventId} back={back} live={live} hidden={{ id: l.id }} style={{ marginTop: 8 }}>
                          <div className="form-row">
                            <div className="field"><label>Priority (lower first, lab-approved)</label><input type="number" name="priority" defaultValue={l.priority} /></div>
                            <div className="field"><label>Est. minutes</label><input type="number" name="est_minutes" defaultValue={l.est_minutes ?? ''} /></div>
                          </div>
                          <div className="field"><label>Must come after (lab-approved)</label><select name="depends_on" multiple defaultValue={l.depends_on_test_ids} style={{ height: 90 }}>
                            {plain.filter((o) => o.id !== l.id).map((o) => <option key={o.test_id} value={o.test_id}>{test(o.test_id)?.display_name}</option>)}</select></div>
                          <div className="row"><label className="check"><input type="checkbox" name="fasting_required" defaultChecked={l.fasting_required} />Fasting required</label>
                            <label className="check"><input type="checkbox" name="required" defaultChecked={l.required} />Required</label><SubmitButton className="btn btn-ghost btn-sm">Save</SubmitButton></div>
                        </AdminForm>
                        <AdminForm action={removePackageTest} eventId={eventId} back={back} live={live} hidden={{ id: l.id }} style={{ marginTop: 6 }}>
                          <SubmitButton className="btn btn-red btn-sm" confirm="Remove from this package for new registrations?">Remove from package</SubmitButton></AdminForm>
                      </>) : null}
                    </details>
                  </li>); })}</ul>
                {canMap ? (
                  <details style={{ marginTop: 10 }} open={!plain.length}>
                    <summary className="btn btn-solid btn-sm">{plain.length ? 'Choose tests for this package' : 'Add tests to this package'}</summary>
                    <AdminForm action={setPackageTests} eventId={eventId} back={back} live={live} hidden={{ package_id: p.id }} style={{ marginTop: 10 }}>
                      <PackageTestPicker tests={pickTests} initial={plain.map((l) => l.test_id)} />
                      <SubmitButton className="btn btn-solid" confirm="Save this package's tests? New registrations get the new list; existing ones keep theirs.">Save package tests</SubmitButton>
                    </AdminForm>
                    {ctx.can('catalogue.edit') ? (
                      <details style={{ marginTop: 12 }}>
                        <summary className="btn btn-ghost btn-sm">Test not in the list? Create it here (e.g. ECG, Ultrasound, 2D Echo)</summary>
                        <AdminForm action={addNewTestToPackage} eventId={eventId} back={back} live={live} hidden={{ package_id: p.id }} style={{ marginTop: 10 }}>
                          <div className="form-row">
                            <div className="field" style={{ flex: 2 }}><label htmlFor={`nt-${p.id}`}>Test name</label><input id={`nt-${p.id}`} name="test_name" required maxLength={200} placeholder="e.g. 2D Echo" /></div>
                            <div className="field"><label htmlFor={`nc-${p.id}`}>Category</label><input id={`nc-${p.id}`} name="category" placeholder="e.g. Cardiac, Radiology" /></div>
                            {ctx.can('addon.price.edit') ? <div className="field"><label htmlFor={`np-${p.id}`}>Price if sold alone (₹, optional)</label><input id={`np-${p.id}`} name="price" inputMode="decimal" /></div> : null}
                          </div>
                          <div className="form-row">
                            <div className="field"><label htmlFor={`nv-${p.id}`}>Done during which visit?</label>
                              <select id={`nv-${p.id}`} name="service_id" defaultValue=""><option value="">A new visit (named below, or same as the test)</option>
                                {(services ?? []).filter((v) => v.active).map((v) => <option key={v.id} value={v.id}>{v.name} ({locationLabel(v.location)})</option>)}</select></div>
                            <div className="field"><label htmlFor={`nn-${p.id}`}>New visit name (optional)</label><input id={`nn-${p.id}`} name="new_service" list="visits-pkg" maxLength={80} placeholder="e.g. Ultrasound (USG)" /></div>
                          </div>
                          <label className="check small"><input type="checkbox" name="walk_in" />Done later at the walk-in centre (new visit only)</label>
                          <p className="small muted" style={{ margin: '6px 0' }}>Then make sure a station does this visit (Stations &amp; counters). One room can do several visits, e.g. Ultrasound and 2D Echo.</p>
                          <SubmitButton className="btn btn-solid btn-sm">Create test and add to package</SubmitButton>
                        </AdminForm>
                      </details>) : null}
                  </details>) : null}
                {canMap && pg.length ? (
                  <AdminForm action={addPackageTest} eventId={eventId} back={back} live={live} hidden={{ package_id: p.id }} className="row" style={{ marginTop: 10 }}>
                    <select name="test_id" className="input" required style={{ flex: 1 }} aria-label="Test to add as a choice option">
                      {(tests ?? []).filter((t) => t.active && !t.archived && !lines.some((l) => l.test_id === t.id)).map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}</select>
                    <select name="choice_group_id" className="input" required style={{ width: 190 }} aria-label="Choice group">{pg.map((g) => <option key={g.id} value={g.id}>Option in {g.name}</option>)}</select>
                    <SubmitButton className="btn btn-ghost btn-sm">Add option</SubmitButton>
                  </AdminForm>) : null}
                {canMap ? <p className="small muted" style={{ marginTop: 6 }}>Test missing? <Link href={`/e/${eventId}/admin/catalog`}>Create it in the test catalogue</Link> and map it to a workflow service, then add it here.</p> : null}
                <div className="label" style={{ margin: '16px 0 8px' }}>Choice groups</div>
                {pg.map((g) => (
                  <AdminForm key={g.id} action={saveChoiceGroup} eventId={eventId} back={back} live={live} hidden={{ id: g.id, package_id: p.id, code: g.code }} style={{ marginBottom: 12 }}>
                    <div className="small text2">Options: {lines.filter((l) => l.choice_group_id === g.id).map((l) => test(l.test_id)?.display_name).join(' / ') || 'none'} {g.source_wording ? <span className="muted">· brochure: “{g.source_wording}”</span> : null}</div>
                    <div className="form-row">
                      <div className="field"><label>Name</label><input name="name" defaultValue={g.name} required /></div>
                      <div className="field"><label>Rule</label><select name="rule" defaultValue={g.rule}><option value="one_of">Choose exactly one</option><option value="one_or_more">Choose one or more</option><option value="bundled">Bundled (all options)</option></select></div>
                      <div className="field"><label>Service</label><select name="service_id" defaultValue={g.service_id}>{(services ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
                    </div>
                    <div className="row"><label className="check"><input type="checkbox" name="separate_tasks" defaultChecked={g.separate_tasks} />Each selected option is a separate task</label>{canMap ? <SubmitButton className="btn btn-ghost btn-sm">Save group</SubmitButton> : null}</div>
                  </AdminForm>))}
              </div>
            </div>
          </Card>
        );
      })}

      {!sp.pkg ? (
      <details className="card"><summary className="strong" style={{ cursor: 'pointer' }}>Visits (physical queue stops) — {(services ?? []).length}</summary>
      <p className="small muted">A visit is one queue stop. Tests are linked to visits in the Test catalogue; stations say which visits they do.</p>
        <div className="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Location</th><th>Priority</th><th>Est. min</th><th>Tests</th><th></th></tr></thead>
          <tbody>{((services ?? []) as Svc[]).map((s) => (
            <tr key={s.id}><td className="mono">{s.code}</td><td className="strong">{s.name}{!s.active ? <span className="badge"> inactive</span> : null}</td><td>{locationLabel(s.location)}</td><td>{s.priority}</td><td>{s.est_minutes ?? '—'}</td>
              <td className="wrap small">{(map ?? []).filter((m) => m.service_id === s.id).map((m) => test(m.test_id)?.display_name).join(', ')}</td>
              <td>{canMap ? <details><summary className="btn btn-ghost btn-sm">Edit</summary><div style={{ width: 'min(560px, 86vw)', whiteSpace: 'normal', padding: '10px 0' }}>
                <ServiceForm s={s} eventId={eventId} back={back} live={live} /></div></details> : null}</td></tr>))}</tbody></table></div>
        {canMap ? <div style={{ marginTop: 16 }}><div className="label">New visit</div><ServiceForm eventId={eventId} back={back} live={live} /></div> : null}
      </details>) : null}
    </>
  );
}

function ServiceForm({ s, eventId, back, live }: { s?: Svc; eventId: string; back: string; live: boolean }) {
  return (
    <AdminForm action={saveService} eventId={eventId} back={back} live={live} hidden={{ id: s?.id }}>
      <div className="form-row">
        <div className="field"><label>Code</label><input name="code" defaultValue={s?.code} required /></div>
        <div className="field"><label>Name</label><input name="name" defaultValue={s?.name} required /></div>
        <div className="field"><label>Location</label><select name="location" defaultValue={s?.location ?? 'event_day'}><option value="event_day">Event day</option><option value="walk_in">Walk-in centre</option></select></div>
        <div className="field"><label>Priority</label><input type="number" name="priority" defaultValue={s?.priority ?? 100} /></div>
        <div className="field"><label>Est. minutes</label><input type="number" name="est_minutes" defaultValue={s?.est_minutes ?? ''} /></div>
      </div>
      <div className="field"><label>Instructions</label><input name="instructions" defaultValue={s?.instructions} /></div>
      <div className="row"><label className="check"><input type="checkbox" name="active" defaultChecked={s?.active ?? true} />Active</label><SubmitButton className="btn btn-solid btn-sm">{s ? 'Save' : 'Create service'}</SubmitButton></div>
    </AdminForm>
  );
}
