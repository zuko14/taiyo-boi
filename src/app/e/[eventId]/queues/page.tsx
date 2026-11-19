import Link from 'next/link';
import { LiveRefresh } from '@/components/LiveRefresh';
import { ReasonAction, RpcForm } from '@/components/RpcForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, Empty, PageHead, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { env } from '@/lib/env';
import { dt } from '@/lib/format';

export default async function Queues({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await requirePerm(eventId, 'queue.override', 'station.operate');
  const tz = ctx.event.timezone;
  const back = `/e/${eventId}/queues`;
  const [{ data: stations }, { data: caps }, { data: problems }, { data: active }, { data: coverage }] = await Promise.all([
    ctx.supabase.from('stations').select('id, code, name, kind, status, pause_reason').eq('event_id', eventId).in('kind', ['station', 'walkin_centre']).order('code'),
    ctx.supabase.from('station_capabilities').select('station_id, service_id').eq('event_id', eventId),
    ctx.supabase.from('participant_tasks').select('id, service_id, service_name, status, status_reason, waiting_since, updated_at, location, registration_id, registrations(registration_code, participants(full_name))')
      .eq('event_id', eventId).in('status', ['waiting_unassigned', 'exception', 'no_show']).order('updated_at').limit(200),
    ctx.supabase.from('queue_assignments').select('id, station_id, state, seq, task_id, participant_tasks(service_id, service_name), registrations(registration_code)')
      .eq('event_id', eventId).in('state', ['queued', 'called', 'in_service']).order('seq'),
    ctx.supabase.rpc('service_coverage', { p_event: eventId }),
  ]);
  type Cov = { service_id: string; service_name: string; station_id: string | null; station_code: string | null; station_name: string | null;
    station_status: string | null; accepts: boolean | null; staff_now: number; next_shift: string | null; waiting: number };
  const services = [...new Map(((coverage ?? []) as Cov[]).map((c) => [c.service_id, c])).values()].map((svc) => {
    const rows = ((coverage ?? []) as Cov[]).filter((c) => c.service_id === svc.service_id && c.station_id);
    const ready = rows.filter((r) => r.station_status === 'open' && r.accepts && r.staff_now > 0);
    return { ...svc, rows, ready };
  });
  const blocked = services.filter((s) => !s.ready.length);
  const why = (r: Cov) => [r.station_status !== 'open' ? r.station_status : null, r.accepts === false ? 'not accepting' : null,
    r.staff_now ? null : r.next_shift ? `no staff until ${dt(r.next_shift, tz, false)}` : 'no staff shift'].filter(Boolean).join(', ');
  type Reg = { registration_code: string; participants?: { full_name: string } };
  const compatible = (serviceId: string) => (stations ?? []).filter((s) => s.kind === 'station' && s.status === 'open' && (caps ?? []).some((c) => c.station_id === s.id && c.service_id === serviceId));

  return (
    <>
      <PageHead title="Queue control" meta="Assignment and calling are automatic (least-busy station first). Here you open, pause or close stations and resolve exceptions. In-service participants are never moved.">
        <LiveRefresh eventId={eventId} tables={['queue_assignments', 'stations', 'participant_tasks']} url={env().NEXT_PUBLIC_SUPABASE_URL} anonKey={env().NEXT_PUBLIC_SUPABASE_ANON_KEY} />
        {ctx.can('queue.override') ? <RpcForm eventId={eventId} rpc="rebalance_waiting" back={back} ok="Waiting participants re-checked" hidden={{ p_event: eventId }}><SubmitButton className="btn btn-ghost btn-sm">Re-run allocation</SubmitButton></RpcForm> : null}
      </PageHead>

      <Card title="Station coverage" sub="The queue is automatic: a participant can only be sent to a station that is open and has staff on shift now. Every service needs at least one."
        actions={blocked.length ? <span className="badge red">{blocked.length} service{blocked.length === 1 ? '' : 's'} cannot be served</span> : <span className="badge green">All services covered</span>}>
        {services.length ? (
          <div className="table-wrap"><table><thead><tr><th>Service</th><th>Ready stations</th><th>Waiting</th><th>Problem and fix</th></tr></thead>
            <tbody>{services.map((s) => (
              <tr key={s.service_id}>
                <td className="strong">{s.service_name}</td>
                <td>{s.ready.length ? s.ready.map((r) => `${r.station_code} (${r.staff_now} staff)`).join(', ') : <span className="badge red">none</span>}</td>
                <td>{s.waiting || '—'}</td>
                <td className="wrap small">{s.ready.length ? <span className="muted">OK</span>
                  : !s.rows.length ? <>No station can do this service. <Link href={`/e/${eventId}/admin/stations`}>Map one in Stations &amp; counters</Link>.</>
                  : <div className="stack">{s.rows.map((r) => (
                      <div key={r.station_id} className="row" style={{ gap: 8 }}>
                        <span><span className="mono">{r.station_code}</span>: {why(r)}</span>
                        {ctx.can('station.operate') && r.station_status !== 'open' ? <RpcForm eventId={eventId} rpc="station_set_status" back={back} ok={`${r.station_name} opened`} hidden={{ p_station: r.station_id, p_status: 'open' }}><SubmitButton className="btn btn-green btn-sm">Open</SubmitButton></RpcForm> : null}
                        {!r.staff_now ? <Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/admin/staff`}>Assign shift</Link> : null}
                      </div>))}</div>}</td>
              </tr>))}</tbody></table></div>
        ) : <Empty>No event-day services configured.</Empty>}
      </Card>

      <Card title="Needs attention" sub="Waiting with no compatible station, exceptions and no-shows">
        {problems?.length ? (
          <div className="table-wrap"><table><thead><tr><th>Participant</th><th>Service</th><th>Status</th><th>Since</th><th>Actions</th></tr></thead>
            <tbody>{problems.map((t) => { const r = t.registrations as unknown as Reg; return (
              <tr key={t.id}><td><Link className="mono strong" href={`/e/${eventId}/participants/${t.registration_id}`}>{r.registration_code}</Link><div className="small muted">{r.participants?.full_name}</div></td>
                <td>{t.service_name}</td><td><StatusBadge status={t.status} />{t.status_reason ? <div className="small muted">{t.status_reason}</div> : null}</td>
                <td>{dt(t.waiting_since ?? t.updated_at, tz, false)}</td>
                <td>{ctx.can('queue.override') ? <ReasonAction eventId={eventId} rpc="task_action" back={back} hidden={{ p_task: t.id, p_action: 'requeue' }} label="Requeue" /> : null}</td></tr>); })}</tbody></table></div>
        ) : <Empty>Nothing needs attention.</Empty>}
      </Card>

      <div className="grid grid-2">
        {(stations ?? []).map((s) => {
          const q = (active ?? []).filter((a) => a.station_id === s.id);
          return (
            <Card key={s.id} title={`${s.name}`} sub={`${s.code}${s.pause_reason ? ` · ${s.pause_reason}` : ''}`} actions={<StatusBadge status={s.status} />}>
              {ctx.can('station.operate') ? (
                <div className="row" style={{ marginBottom: 12 }}>
                  {s.status !== 'open' ? <RpcForm eventId={eventId} rpc="station_set_status" back={back} ok={`${s.name} opened`} hidden={{ p_station: s.id, p_status: 'open' }}><SubmitButton className="btn btn-green btn-sm">Open</SubmitButton></RpcForm> : null}
                  {s.status === 'open' ? <ReasonAction eventId={eventId} rpc="station_set_status" back={back} hidden={{ p_station: s.id, p_status: 'paused' }} label="Pause" ok="Paused — waiting tickets moved" /> : null}
                  {s.status !== 'closed' ? <ReasonAction eventId={eventId} rpc="station_set_status" back={back} hidden={{ p_station: s.id, p_status: 'closed' }} label="Close" danger ok="Closed — waiting tickets moved" /> : null}
                </div>) : null}
              {q.length ? <ul className="list">{q.map((a) => { const t = a.participant_tasks as unknown as { service_id: string; service_name: string }; return (
                <li key={a.id} style={{ display: 'block' }}><div className="row-between"><span>#{a.seq} · <span className="mono">{(a.registrations as unknown as Reg).registration_code}</span> · {t.service_name}</span><StatusBadge status={a.state} /></div>
                  {ctx.can('queue.override') && a.state !== 'in_service' ? (
                    <RpcForm eventId={eventId} rpc="reassign_task" back={back} ok="Reassigned" hidden={{ p_task: a.task_id }} className="row" style={{ marginTop: 6 }}>
                      <select name="p_target_station" className="input" style={{ width: 170, padding: '6px 10px' }} aria-label="Target station">
                        <option value="">Best available</option>{compatible(t.service_id).filter((c) => c.id !== s.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                      <input name="p_reason" className="input" required placeholder="Reason" style={{ flex: 1, padding: '6px 10px' }} aria-label="Reassign reason" />
                      <button className="btn btn-ghost btn-sm">Move</button>
                    </RpcForm>) : null}
                </li>); })}</ul> : <p className="muted small">Queue empty.</p>}
            </Card>
          );
        })}
      </div>
    </>
  );
}
