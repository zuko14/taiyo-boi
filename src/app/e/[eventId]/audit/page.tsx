import Link from 'next/link';
import { Card, Empty, PageHead } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { dt } from '@/lib/format';

const PAGE = 100;

export default async function Audit({ params, searchParams }: { params: Promise<{ eventId: string }>; searchParams: Promise<{ action?: string; entity?: string; page?: string }> }) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm(eventId, 'audit.view');
  const page = Math.max(0, Number(sp.page ?? 0) || 0);
  let q = ctx.supabase.from('audit_logs').select('id, actor_id, action, entity_type, entity_id, reason, meta, created_at').eq('event_id', eventId)
    .order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
  if (sp.action) q = q.ilike('action', `${sp.action.replace(/[%_]/g, '')}%`);
  if (sp.entity) q = q.eq('entity_type', sp.entity);
  const { data: logs } = await q;
  const actors = [...new Set((logs ?? []).map((l) => l.actor_id).filter(Boolean))];
  const { data: names } = actors.length ? await ctx.supabase.from('staff_profiles').select('user_id, full_name').in('user_id', actors) : { data: [] };
  const who = (id: string | null) => (id ? (names ?? []).find((n) => n.user_id === id)?.full_name ?? id.slice(0, 8) : 'system / participant');
  return (
    <>
      <PageHead title="Audit log" meta="Append-only record of consequential actions." />
      <Card>
        <form className="row" method="get">
          <input className="input" name="action" defaultValue={sp.action} placeholder="Action starts with… (e.g. task., payment.)" style={{ flex: 1 }} aria-label="Action filter" />
          <input className="input" name="entity" defaultValue={sp.entity} placeholder="Entity type (e.g. registration)" style={{ width: 220 }} aria-label="Entity filter" />
          <button className="btn btn-ghost">Filter</button>
        </form>
      </Card>
      <Card>
        {logs?.length ? <div className="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Reason</th><th>Details</th></tr></thead>
          <tbody>{logs.map((l) => (
            <tr key={l.id}><td>{dt(l.created_at, ctx.event.timezone)}</td><td>{who(l.actor_id)}</td><td className="mono small">{l.action}</td>
              <td className="small">{l.entity_type}{l.entity_id ? <span className="muted"> · {String(l.entity_id).slice(0, 8)}</span> : null}</td>
              <td className="wrap small">{l.reason ?? '—'}</td>
              <td><details><summary className="small" style={{ cursor: 'pointer' }}>view</summary><pre className="mono small" style={{ whiteSpace: 'pre-wrap', maxWidth: 480 }}>{JSON.stringify(l.meta, null, 1)}</pre></details></td></tr>))}</tbody></table></div>
          : <Empty>No entries.</Empty>}
        <div className="row" style={{ marginTop: 12 }}>
          {page > 0 ? <Link className="btn btn-ghost btn-sm" href={`?action=${sp.action ?? ''}&entity=${sp.entity ?? ''}&page=${page - 1}`}>Newer</Link> : null}
          {(logs?.length ?? 0) === PAGE ? <Link className="btn btn-ghost btn-sm" href={`?action=${sp.action ?? ''}&entity=${sp.entity ?? ''}&page=${page + 1}`}>Older</Link> : null}
        </div>
      </Card>
    </>
  );
}
