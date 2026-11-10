import Link from 'next/link';
import { redirect } from 'next/navigation';
import { LiveRefresh } from '@/components/LiveRefresh';
import { Card, PageHead, Stat, StatusBadge } from '@/components/ui';
import { getEventContext } from '@/lib/auth';
import { nowMs } from '@/lib/clock';
import { env } from '@/lib/env';
import { inr, statusLabel } from '@/lib/format';

type Overview = {
  registrations: { total: number; female: number; male: number; arrived: number; last_hour: number };
  by_counter: { name: string; count: number }[]; by_staff: { name: string; count: number }[];
  tasks: Record<string, number>;
  stations: { id: string; code: string; name: string; kind: string; status: string; pause_reason: string | null; staff: number; queued: number; in_service: number; completed: number; services: string | null; est_wait: number }[];
  waiting_unassigned: number; awaiting_choice: number;
  payments: { orders: number; by_status: Record<string, number>; received_paise: number } | null;
  reports: { by_status: Record<string, number>; lines_without_report: number; unmatched_imports: number };
  alerts: { level: string; text: string }[];
};

const FIRST_AREA: [string, string][] = [['registration.create', '/register'], ['task.perform', '/station'], ['addon.create', '/addons'],
  ['payment.verify', '/payments'], ['walkin.checkin', '/walkin'], ['report.view', '/reports'], ['finance.view', '/finance'],
  ['sponsor.view', '/attendance'], ['participant.view', '/participants']];

export default async function Dashboard({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can('dashboard.view')) {
    const first = FIRST_AREA.find(([p]) => ctx.can(p));
    redirect(first ? `/e/${eventId}${first[1]}` : '/select-event');
  }
  const t0 = nowMs();
  const { data, error } = await ctx.supabase.rpc('dashboard_overview', { p_event: eventId });
  const dbMs = nowMs() - t0;
  if (error || !data) return <Card title="Dashboard unavailable"><div className="alert alert-err">Could not load live data. Check the database connection.</div></Card>;
  const o = data as Overview;
  const r = o.registrations;
  const sumTasks = (loc: string, states: string[]) => states.reduce((n, s) => n + (o.tasks[`${loc}:${s}`] ?? 0), 0);
  const ed = { done: sumTasks('event_day', ['completed']), open: sumTasks('event_day', ['not_ready', 'waiting_unassigned', 'queued', 'called', 'in_service']), exc: sumTasks('event_day', ['exception', 'no_show']) };
  const wi = { done: sumTasks('walk_in', ['completed']), open: sumTasks('walk_in', ['not_attended', 'awaiting_choice', 'checked_in', 'in_service']) };
  const diag = o.stations.filter((s) => s.kind === 'station');

  return (
    <>
      <PageHead title="Live operations" meta={<>{ctx.event.venue || 'Venue not set'} · <StatusBadge status={ctx.event.status} /></>}>
        <LiveRefresh eventId={eventId} tables={['registrations', 'queue_assignments', 'stations', 'payment_intents', 'reports']}
          url={env().NEXT_PUBLIC_SUPABASE_URL} anonKey={env().NEXT_PUBLIC_SUPABASE_ANON_KEY} />
        <span className="small muted">DB {dbMs} ms</span>
      </PageHead>

      {o.alerts.map((a, i) => <div key={i} className={`alert ${a.level === 'error' ? 'alert-err' : 'alert-warn'}`} role="alert">{a.text}</div>)}

      <div className="stats">
        <Stat label="Registered" value={r.total} hint={`${r.last_hour} in the last hour`} />
        <Stat label="Female / Male" value={`${r.female} / ${r.male}`} hint={r.total ? `${Math.round((r.female / r.total) * 100)}% / ${Math.round((r.male / r.total) * 100)}%` : '—'} />
        <Stat label="Appeared" value={r.arrived} hint="at least one service started" />
        <Stat label="Waiting, no station" value={o.waiting_unassigned} tone={o.waiting_unassigned ? 'warn' : undefined} hint="participants" />
        <Stat label="Event-day services" value={`${ed.done}`} hint={`${ed.open} open · ${ed.exc} exceptions/no-shows`} />
        <Stat label="Walk-in pending" value={wi.open} hint={`${wi.done} completed · ${o.awaiting_choice} awaiting choice`} />
      </div>

      <Card title="Stations" sub="Queue load and staffing right now" actions={ctx.can('queue.override', 'station.operate') ? <Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/queues`}>Queue control</Link> : null}>
        <div className="table-wrap"><table>
          <thead><tr><th>Station</th><th>Services</th><th>Status</th><th>Staff</th><th>Waiting</th><th>In service</th><th>Done</th><th>Est. wait</th></tr></thead>
          <tbody>{diag.map((s) => (
            <tr key={s.id}><td className="strong">{s.name} <span className="muted small">{s.code}</span></td><td className="wrap small">{s.services ?? '—'}</td>
              <td><StatusBadge status={s.status} />{s.pause_reason ? <div className="small muted">{s.pause_reason}</div> : null}</td>
              <td>{s.staff === 0 && s.status === 'open' ? <span className="badge red">none</span> : s.staff}</td>
              <td>{s.queued}</td><td>{s.in_service}</td><td>{s.completed}</td><td>{s.status === 'open' ? `${s.est_wait} min` : '—'}</td></tr>
          ))}</tbody>
        </table></div>
      </Card>

      <div className="grid grid-2">
        <Card title="Registrations by counter">
          <ul className="list">{o.by_counter.map((c) => <li key={c.name}><span>{c.name}</span><span className="strong">{c.count}</span></li>)}
            {!o.by_counter.length ? <li className="muted">No registrations yet</li> : null}</ul>
          {o.by_staff.length ? <><div className="hr" /><div className="label" style={{ marginBottom: 6 }}>By staff</div>
            <ul className="list">{o.by_staff.map((c) => <li key={c.name}><span>{c.name}</span><span>{c.count}</span></li>)}</ul></> : null}
        </Card>
        <div>
          {o.payments ? (
            <Card title="Add-on payments" sub="Employee-paid only — kept separate from sponsored packages">
              <ul className="list">
                <li><span>Add-on orders</span><span className="strong">{o.payments.orders}</span></li>
                {Object.entries(o.payments.by_status).map(([k, v]) => <li key={k}><StatusBadge status={k} /><span>{v}</span></li>)}
                <li><span>Verified received (net of refunds)</span><span className="strong">{inr(o.payments.received_paise)}</span></li>
              </ul>
            </Card>
          ) : null}
          <Card title="Reports">
            <ul className="list">
              <li><span>Test lines without a report</span><span className="strong">{o.reports.lines_without_report}</span></li>
              {Object.entries(o.reports.by_status).map(([k, v]) => <li key={k}><span>{statusLabel(k)}</span><span>{v}</span></li>)}
              <li><span>Unmatched imports</span><span>{o.reports.unmatched_imports}</span></li>
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
