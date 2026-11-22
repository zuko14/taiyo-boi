import Link from 'next/link';
import { Icon } from '@/components/Icons';
import { Card, Empty, PageHead, Progress, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { classLabel, dt } from '@/lib/format';
import { parseScan } from '@/lib/tokens';
import { redirect } from 'next/navigation';

const PAGE = 50;

export default async function Participants({ params, searchParams }: { params: Promise<{ eventId: string }>; searchParams: Promise<{ q?: string; cls?: string; page?: string; doc?: string }> }) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm(eventId, 'participant.view');
  const q = (sp.q ?? '').trim();
  const page = Math.max(0, Number(sp.page ?? 0) || 0);

  // a scanned QR/URL or exact code jumps straight to the participant
  if (q) {
    const s = parseScan(q);
    if (s.tokenHash || /^[A-Z0-9]+-[A-Z]+-\d{4}-\d+$/.test(s.code ?? '')) {
      const { data: id } = await ctx.supabase.rpc('resolve_scan', { p_event: eventId, p_code: s.code, p_token_hash: s.tokenHash });
      if (id) redirect(`/e/${eventId}/participants/${id}`);
    }
  }

  let query = ctx.supabase.from('registration_overview').select('*', { count: 'exact' }).eq('event_id', eventId)
    .order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
  if (sp.cls && /^[a-z0-9_]{1,30}$/.test(sp.cls)) query = query.eq('classification', sp.cls);
  // doctor filter: consulted (any / one doctor) or referred (any / one doctor)
  const { data: doctors } = await ctx.supabase.from('doctors').select('id, name').eq('event_id', eventId).order('name');
  const doc = sp.doc && /^(consulted|referred|[0-9a-f-]{36})$/.test(sp.doc) ? sp.doc : '';
  if (doc) {
    const one = doc.length === 36 ? doc : null;
    const [{ data: cIds }, { data: oIds }, { data: rIds }] = await Promise.all([
      doc === 'referred' ? Promise.resolve({ data: [] }) : (one ? ctx.supabase.from('consultations').select('registration_id').eq('event_id', eventId).neq('status', 'cancelled').eq('doctor_id', one)
        : ctx.supabase.from('consultations').select('registration_id').eq('event_id', eventId).neq('status', 'cancelled')),
      doc === 'consulted' ? Promise.resolve({ data: [] }) : (one ? ctx.supabase.from('orders').select('registration_id').eq('event_id', eventId).eq('referred_by_doctor_id', one)
        : ctx.supabase.from('orders').select('registration_id').eq('event_id', eventId).or('referred_by_doctor_id.not.is.null,referred_by_name.not.is.null')),
      doc === 'consulted' ? Promise.resolve({ data: [] }) : (one ? ctx.supabase.from('registrations').select('registration_id:id').eq('event_id', eventId).eq('referred_by_doctor_id', one)
        : ctx.supabase.from('registrations').select('registration_id:id').eq('event_id', eventId).or('referred_by_doctor_id.not.is.null,referred_by_name.not.is.null')),
    ]);
    const ids = [...new Set([...(cIds ?? []), ...(oIds ?? []), ...(rIds ?? [])].map((x) => (x as { registration_id: string }).registration_id))];
    query = query.in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
  }
  if (q) {
    const safe = q.replace(/[%,()]/g, ' ').toLowerCase().replace(/\s+/g, ' ');
    query = query.or(`registration_code.ilike.%${safe}%,name_search.ilike.%${safe}%,employee_id.ilike.%${safe}%,mobile.ilike.%${safe}%`);
  }
  const [{ data: rows, count }, { data: pkgs }] = await Promise.all([query,
    ctx.supabase.from('packages').select('classification, name').eq('event_id', eventId).order('classification')]);
  // doctor column for the rows on this page: consultations and referrals
  const pageIds = (rows ?? []).map((r) => r.id as string);
  const [{ data: pc }, { data: po }, { data: pr }] = pageIds.length ? await Promise.all([
    ctx.supabase.from('consultations').select('registration_id, doctor_id, status').in('registration_id', pageIds).neq('status', 'cancelled'),
    ctx.supabase.from('orders').select('registration_id, referred_by_doctor_id, referred_by_name').in('registration_id', pageIds).or('referred_by_doctor_id.not.is.null,referred_by_name.not.is.null'),
    ctx.supabase.from('registrations').select('id, referred_by_doctor_id, referred_by_name').in('id', pageIds),
  ]) : [{ data: [] }, { data: [] }, { data: [] }];
  const dn = (id: string | null) => (doctors ?? []).find((d) => d.id === id)?.name;
  const doctorCell = (id: string) => {
    const seen = [...new Set((pc ?? []).filter((c) => c.registration_id === id).map((c) => dn(c.doctor_id)).filter(Boolean))];
    const refs = [...new Set([...(po ?? []).filter((o) => o.registration_id === id), ...(pr ?? []).filter((r) => r.id === id)]
      .map((x) => dn(x.referred_by_doctor_id) ?? x.referred_by_name).filter(Boolean))];
    return seen.length || refs.length ? <>{seen.length ? <div>Consulted: {seen.join(', ')}</div> : null}{refs.length ? <div className="muted">Referred: {refs.join(', ')}</div> : null}</> : <span className="muted">—</span>;
  };

  return (
    <>
      <PageHead title="Participants" meta={`${count ?? 0} registration(s)`} />
      <Card>
        <form className="row" method="get">
          <div className="search-bar" style={{ flex: 1, minWidth: 240 }}><Icon name="search" />
            <input name="q" defaultValue={q} placeholder="Scan tag, or search code / name / employee ID / mobile" aria-label="Search participants" autoFocus /></div>
          <select name="cls" defaultValue={sp.cls ?? ''} className="input" style={{ width: 160 }} aria-label="Classification">
            <option value="">All packages</option>{(pkgs ?? []).map((p) => <option key={p.classification} value={p.classification}>{classLabel(p.classification)} · {p.name}</option>)}</select>
          {(doctors ?? []).length ? <select name="doc" defaultValue={doc} className="input" style={{ width: 200 }} aria-label="Doctor">
            <option value="">All patients</option><option value="consulted">Consulted a doctor</option><option value="referred">Referred by a doctor</option>
            {(doctors ?? []).map((d) => <option key={d.id} value={d.id}>{d.name} (consulted or referred)</option>)}</select> : null}
          <button className="btn btn-ghost">Search</button>
        </form>
        <p className="small muted" style={{ margin: '10px 0 0' }}>Similar names are listed, never auto-selected — confirm the code with the participant.</p>
      </Card>
      <Card>
        {rows?.length ? (
          <div className="table-wrap"><table>
            <thead><tr><th>Code</th><th>Name</th><th>Package</th><th>Registered</th><th>Appeared</th><th>Current step</th><th>Event day</th><th>Walk-in</th><th>Add-ons</th><th>Doctor</th><th>Reports</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td><Link className="strong mono" href={`/e/${eventId}/participants/${r.id}`}>{r.registration_code}</Link>{r.status !== 'active' ? <> <StatusBadge status={r.status} /></> : null}</td>
                <td>{r.full_name}</td><td>{classLabel(r.classification)}</td><td>{dt(r.created_at, ctx.event.timezone)}</td>
                <td>{r.arrived_at ? dt(r.arrived_at, ctx.event.timezone, false) : <span className="muted">—</span>}</td>
                <td className="small">{r.current_step ?? (r.has_exception ? <span className="badge red">exception</span> : '—')}</td>
                <td><Progress done={r.ed_done} total={r.ed_total} /></td><td><Progress done={r.wi_done} total={r.wi_total} /></td>
                <td>{r.addon_tasks ? <>{r.addon_tasks} {r.payment_states ? r.payment_states.split(',').map((s: string) => <StatusBadge key={s} status={s} />) : null}</> : '—'}</td>
                <td className="small">{doctorCell(r.id)}</td>
                <td>{r.reports_published || '—'}</td>
              </tr>))}</tbody>
          </table></div>
        ) : <Empty>No participants match.</Empty>}
        <div className="row" style={{ marginTop: 14 }}>
          {page > 0 ? <Link className="btn btn-ghost btn-sm" href={`?q=${encodeURIComponent(q)}&cls=${sp.cls ?? ''}&doc=${doc}&page=${page - 1}`}>Previous</Link> : null}
          {(count ?? 0) > (page + 1) * PAGE ? <Link className="btn btn-ghost btn-sm" href={`?q=${encodeURIComponent(q)}&cls=${sp.cls ?? ''}&doc=${doc}&page=${page + 1}`}>Next</Link> : null}
        </div>
      </Card>
    </>
  );
}
