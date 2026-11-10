import Link from 'next/link';
import { DutyPicker } from '@/components/DutyPicker';
import { LiveRefresh } from '@/components/LiveRefresh';
import { ReasonAction, RpcForm } from '@/components/RpcForm';
import { ScanBox } from '@/components/ScanBox';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, Empty, PageHead, Stat, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { myStations } from '@/lib/duty';
import { env } from '@/lib/env';
import { dt } from '@/lib/format';
import { resolveScan } from '@/lib/scan';

type QA = { id: string; seq: number; state: string; task_id: string; registration_id: string; assigned_at: string; called_at: string | null; started_at: string | null;
  participant_tasks: { service_name: string; source: string; task_items: { order_items: { id: string; test_name: string; completion_rule: string; status: string } }[] };
  registrations: { registration_code: string; participants: { full_name: string; age: number | null } } };

export default async function StationPage({ params, searchParams }: { params: Promise<{ eventId: string }>; searchParams: Promise<{ at?: string; scan?: string }> }) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm(eventId, 'task.perform');
  const tz = ctx.event.timezone;
  const { stations } = await myStations(ctx, ['station']);
  const at = sp.at ?? (stations.length === 1 ? stations[0].id : undefined);
  const base = `/e/${eventId}/station`;
  const back = `${base}?at=${at}`;
  const station = stations.find((s) => s.id === at);

  let content = null;
  if (station) {
    const [{ data: queue }, { count: done }, { data: caps }] = await Promise.all([
      ctx.supabase.from('queue_assignments')
        .select('id, seq, state, task_id, registration_id, assigned_at, called_at, started_at, participant_tasks(service_name, source, task_items(order_items(id, test_name, completion_rule, status))), registrations(registration_code, participants(full_name, age))')
        .eq('station_id', station.id).in('state', ['queued', 'called', 'in_service']).order('seq'),
      ctx.supabase.from('queue_assignments').select('id', { count: 'exact', head: true }).eq('station_id', station.id).eq('state', 'completed'),
      ctx.supabase.from('station_capabilities').select('workflow_services(name)').eq('station_id', station.id),
    ]);
    const rows = (queue ?? []) as unknown as QA[];
    const serving = rows.filter((q) => q.state === 'in_service');
    const called = rows.filter((q) => q.state === 'called');
    const waiting = rows.filter((q) => q.state === 'queued');

    // scanning only finds the participant's task here; it never changes its state
    const scannedReg = await resolveScan(ctx, sp.scan, station.id);
    const scannedRow = scannedReg ? rows.find((q) => q.registration_id === scannedReg) : null;

    const actions = (q: QA) => (
      <div className="row">
        {q.state === 'queued' ? <RpcForm eventId={eventId} rpc="task_action" back={back} hidden={{ p_task: q.task_id, p_action: 'call', p_station: station.id }}><SubmitButton className="btn btn-ghost btn-sm">Call</SubmitButton></RpcForm> : null}
        {q.state !== 'in_service' ? <RpcForm eventId={eventId} rpc="task_action" back={back} ok="Service started" hidden={{ p_task: q.task_id, p_action: 'start', p_station: station.id }}><SubmitButton className="btn btn-solid btn-sm">Start</SubmitButton></RpcForm> : null}
        {q.state === 'in_service' ? <RpcForm eventId={eventId} rpc="task_action" back={back} ok="Completed — next step assigned" hidden={{ p_task: q.task_id, p_action: 'complete', p_station: station.id }}>
          <SubmitButton className="btn btn-green" confirm={`Confirm ${q.participant_tasks.service_name} is finished for ${q.registrations.registration_code}?`}>Complete</SubmitButton></RpcForm> : null}
        {q.state !== 'in_service' ? <ReasonAction eventId={eventId} rpc="task_action" back={back} hidden={{ p_task: q.task_id, p_action: 'no_show', p_station: station.id }} label="No-show" /> : null}
        <ReasonAction eventId={eventId} rpc="task_action" back={back} hidden={{ p_task: q.task_id, p_action: 'exception', p_station: station.id }} label="Exception" danger />
      </div>
    );
    const person = (q: QA) => (
      <div>
        <div className="strong" style={{ fontSize: '1.05rem' }}>#{q.seq} · {q.registrations.participants.full_name} <span className="mono small muted">{q.registrations.registration_code}</span></div>
        <div className="small text2">{q.participant_tasks.service_name}{q.participant_tasks.source === 'addon' ? ' · add-on (paid)' : ''} · {q.participant_tasks.task_items.filter((t) => t.order_items.status === 'active').map((t) => t.order_items.test_name).join(', ')}</div>
      </div>
    );

    content = (
      <>
        <div className="stats">
          <Stat label="Waiting" value={waiting.length} /><Stat label="Called" value={called.length} /><Stat label="In service" value={serving.length} /><Stat label="Completed" value={done ?? 0} />
        </div>
        {station.status !== 'open' ? <div className="alert alert-warn">This station is {station.status}. It receives no new participants.</div> : null}
        <Card>
          <div className="row-between">
            <div style={{ flex: 1, minWidth: 260 }}><ScanBox action={base} hidden={{ at: station.id }} label="Scan participant tag to find their task here" /></div>
            <RpcForm eventId={eventId} rpc="call_next" back={back} ok="Next participant called" hidden={{ p_station: station.id }}><SubmitButton className="btn btn-accent btn-lg">Call next</SubmitButton></RpcForm>
          </div>
          {sp.scan ? (scannedRow ? <div className="alert alert-ok" style={{ marginTop: 12 }}>Found: {scannedRow.registrations.registration_code} — {scannedRow.participant_tasks.service_name} ({scannedRow.state}).</div>
            : <div className="alert alert-err" style={{ marginTop: 12 }}>{scannedReg ? 'This participant has no task assigned to this station.' : 'Tag not recognised.'}{scannedReg ? <> <Link href={`/e/${eventId}/participants/${scannedReg}`}>See their current step</Link></> : null}</div>) : null}
        </Card>
        {[...(scannedRow ? [scannedRow] : []), ...serving, ...called].filter((q, i, a) => a.findIndex((x) => x.id === q.id) === i).map((q) => (
          <section key={q.id} className="glass next-step">
            <div className="eyebrow">{q.state === 'in_service' ? `In service since ${dt(q.started_at, tz, false)}` : q.state === 'called' ? 'Called' : 'Scanned'}</div>
            <div className="row-between" style={{ marginTop: 8 }}>{person(q)}{actions(q)}</div>
          </section>
        ))}
        <Card title="Queue" sub={`Services: ${(caps ?? []).map((c) => (c.workflow_services as unknown as { name: string }).name).join(', ')}`}>
          {waiting.length ? <ul className="list">{waiting.map((q) => <li key={q.id}>{person(q)}{actions(q)}</li>)}</ul> : <Empty>No one waiting.</Empty>}
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHead title={station ? station.name : 'My station'} meta={station ? `${station.code} · ${station.location}` : 'Choose your assigned station'}>
        {station ? <><StatusBadge status={station.status} /><LiveRefresh eventId={eventId} tables={['queue_assignments', 'stations']} url={env().NEXT_PUBLIC_SUPABASE_URL} anonKey={env().NEXT_PUBLIC_SUPABASE_ANON_KEY} pollMs={10000} /></> : null}
      </PageHead>
      <DutyPicker stations={stations} base={base} title="Station" current={at} />
      {content}
    </>
  );
}
