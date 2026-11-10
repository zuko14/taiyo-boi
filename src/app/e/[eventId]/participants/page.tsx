import Link from 'next/link';
import { Icon } from '@/components/Icons';
import { Card, Empty, PageHead, Progress, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { classLabel, dt } from '@/lib/format';
import { parseScan } from '@/lib/tokens';
import { redirect } from 'next/navigation';

const PAGE = 50;

export default async function Participants({ params, searchParams }: { params: Promise<{ eventId: string }>; searchParams: Promise<{ q?: string; cls?: string; page?: string }> }) {
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
  if (sp.cls === 'female' || sp.cls === 'male') query = query.eq('classification', sp.cls);
  if (q) {
    const safe = q.replace(/[%,()]/g, ' ').toLowerCase().replace(/\s+/g, ' ');
    query = query.or(`registration_code.ilike.%${safe}%,name_search.ilike.%${safe}%,employee_id.ilike.%${safe}%,mobile.ilike.%${safe}%`);
  }
  const { data: rows, count } = await query;

  return (
    <>
      <PageHead title="Participants" meta={`${count ?? 0} registration(s)`} />
      <Card>
        <form className="row" method="get">
          <div className="search-bar" style={{ flex: 1, minWidth: 240 }}><Icon name="search" />
            <input name="q" defaultValue={q} placeholder="Scan tag, or search code / name / employee ID / mobile" aria-label="Search participants" autoFocus /></div>
          <select name="cls" defaultValue={sp.cls ?? ''} className="input" style={{ width: 160 }} aria-label="Classification">
            <option value="">All packages</option><option value="female">Female</option><option value="male">Male</option></select>
          <button className="btn btn-ghost">Search</button>
        </form>
        <p className="small muted" style={{ margin: '10px 0 0' }}>Similar names are listed, never auto-selected — confirm the code with the participant.</p>
      </Card>
      <Card>
        {rows?.length ? (
          <div className="table-wrap"><table>
            <thead><tr><th>Code</th><th>Name</th><th>Package</th><th>Registered</th><th>Appeared</th><th>Current step</th><th>Event day</th><th>Walk-in</th><th>Add-ons</th><th>Reports</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td><Link className="strong mono" href={`/e/${eventId}/participants/${r.id}`}>{r.registration_code}</Link>{r.status !== 'active' ? <> <StatusBadge status={r.status} /></> : null}</td>
                <td>{r.full_name}</td><td>{classLabel(r.classification)}</td><td>{dt(r.created_at, ctx.event.timezone)}</td>
                <td>{r.arrived_at ? dt(r.arrived_at, ctx.event.timezone, false) : <span className="muted">—</span>}</td>
                <td className="small">{r.current_step ?? (r.has_exception ? <span className="badge red">exception</span> : '—')}</td>
                <td><Progress done={r.ed_done} total={r.ed_total} /></td><td><Progress done={r.wi_done} total={r.wi_total} /></td>
                <td>{r.addon_tasks ? <>{r.addon_tasks} {r.payment_states ? r.payment_states.split(',').map((s: string) => <StatusBadge key={s} status={s} />) : null}</> : '—'}</td>
                <td>{r.reports_published || '—'}</td>
              </tr>))}</tbody>
          </table></div>
        ) : <Empty>No participants match.</Empty>}
        <div className="row" style={{ marginTop: 14 }}>
          {page > 0 ? <Link className="btn btn-ghost btn-sm" href={`?q=${encodeURIComponent(q)}&cls=${sp.cls ?? ''}&page=${page - 1}`}>Previous</Link> : null}
          {(count ?? 0) > (page + 1) * PAGE ? <Link className="btn btn-ghost btn-sm" href={`?q=${encodeURIComponent(q)}&cls=${sp.cls ?? ''}&page=${page + 1}`}>Next</Link> : null}
        </div>
      </Card>
    </>
  );
}
