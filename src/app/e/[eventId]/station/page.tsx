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
import { ScanMatches } from '@/components/ScanMatches';
import { resolveScan, searchRegistrations } from '@/lib/scan';

type QA = { id: string; seq: number; state: string; task_id: string; registration_id: string; assigned_at: string; called_at: string | null; started_at: string | null;
  participant_tasks: { service_id: string; service_name: string; source: string; task_items: { order_items: { id: string; test_name: string; completion_rule: string; status: string } }[] };
  registrations: { registration_code: string; participants: { full_name: string; age: number | null } } };

export default async function StationPage({ params, searchParams }: { params: Promise<{ eventId: string }>; searchParams: Promise<{ at?: string; scan?: string; reg?: string }> }) {
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
        .select('id, seq, state, task_id, registration_id, assigned_at, called_at, started_at, participant_tasks(service_id, service_name, source, task_items(order_items(id, test_name, completion_rule, status))), registrations(registration_code, participants(full_name, age))')
        .eq('station_id', station.id).in('state', ['queued', 'called', 'in_service']).order('seq'),
      ctx.supabase.from('queue_assignments').select('id', { count: 'exact', head: true }).eq('station_id', station.id).eq('state', 'completed'),
      ctx.supabase.from('station_capabilities').select('service_id, workflow_services(name)').eq('station_id', station.id),
    ]);
    const rows = (queue ?? []) as unknown as QA[];
    const serving = rows.filter((q) => q.state === 'in_service');
    const called = rows.filter((q) => q.state === 'called');
    const waiting = rows.filter((q) => q.state === 'queued');

    // scanning only finds the participant's task here; it never changes its state
    const scannedReg = sp.reg ?? (await resolveScan(ctx, sp.scan, station.id));
    const scannedRow = scannedReg ? rows.find((q) => q.registration_id === scannedReg) : null;
    const matches = sp.scan && !scannedReg ? await searchRegistrations(ctx, sp.scan) : [];
    const capIds = new Set((caps ?? []).map((c) => c.service_id as string));
    // scanned participant waiting at another station that offers the same service: can be served here
    const { data: elsewhere } = scannedReg && !scannedRow ? await ctx.supabase.from('queue_assignments')
      .select('task_id, state, stations(name, code), participant_tasks(service_id, service_name)')
      .eq('registration_id', scannedReg).in('state', ['queued', 'called', 'in_service']).maybeSingle() : { data: null };
    const other = elsewhere as unknown as { task_id: string; state: string; stations: { name: string; code: string }; participant_tasks: { service_id: string; service_name: string } } | null;

    // other tasks of the same service for these participants (e.g. a paid add-on collected in the same visit)
    type Sib = { registration_id: string; service_id: string; source: string; payment_cleared: boolean; task_items: { order_items: { test_name: string; status: string } }[] };
    const regIds = [...new Set(rows.map((q) => q.registration_id))];
    const { data: sibData } = regIds.length ? await ctx.supabase.from('participant_tasks')
      .select('registration_id, service_id, source, payment_cleared, task_items(order_items(test_name, status))')
      .in('registration_id', regIds).eq('location', 'event_day').in('status', ['not_ready', 'waiting_unassigned']) : { data: [] };
    const sibs = (sibData ?? []) as unknown as Sib[];
    const paidOk = (x: Sib) => x.payment_cleared;
    const names = (x: Sib) => x.task_items.filter((i) => i.order_items.status === 'active').map((i) => i.order_items.test_name).join(', ');
    const companions = (q: QA) => {
      const same = sibs.filter((x) => x.registration_id === q.registration_id && x.service_id === q.participant_tasks.service_id);
      const ok = same.filter(paidOk); const pending = same.filter((x) => !paidOk(x));
      return (<>
        {ok.length ? <div className="small" style={{ marginTop: 4 }}><span className="badge green">Also in this visit</span> {ok.map(names).join(', ')} {ok.some((x) => x.source === 'addon') ? '(add-on, paid)' : ''} — completed together with this service.</div> : null}
        {pending.length ? <div className="small" style={{ marginTop: 4 }}><span className="badge amber">Payment pending</span> {pending.map(names).join(', ')} — not included until the cashier verifies payment.</div> : null}
      </>);
    };

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
        <div className="small text2">{q.participant_tasks.service_name}{q.participant_tasks.source === 'addon' ? ' · add-on' : ''} · {q.participant_tasks.task_items.filter((t) => t.order_items.status === 'active').map((t) => t.order_items.test_name).join(', ')}</div>
        {companions(q)}
        {q.state === 'in_service' ? <div className="row" style={{ marginTop: 6 }}>{q.participant_tasks.task_items.filter((t) => t.order_items.status === 'active' && t.order_items.completion_rule === 'manual_confirm').map((t) => (
          <RpcForm key={t.order_items.id} eventId={eventId} rpc="confirm_order_item" back={back} ok={`${t.order_items.test_name} confirmed`} hidden={{ p_order_item: t.order_items.id, p_station: station.id }}>
            <SubmitButton className="btn btn-ghost btn-sm">Confirm {t.order_items.test_name} done</SubmitButton></RpcForm>))}</div> : null}
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
          {scannedReg ? (scannedRow ? <div className="alert alert-ok" style={{ marginTop: 12 }}>Found: {scannedRow.registrations.registration_code} — {scannedRow.participant_tasks.service_name} ({scannedRow.state}).</div>
            : other && other.state !== 'in_service' && capIds.has(other.participant_tasks.service_id) ? (
              <div className="alert alert-warn row-between" style={{ marginTop: 12 }}>
                <span>This participant is waiting for {other.participant_tasks.service_name} at {other.stations.name} ({other.stations.code}). This station offers the same service.</span>
                <RpcForm eventId={eventId} rpc="claim_task" back={back} ok="Moved to this station" hidden={{ p_task: other.task_id, p_station: station.id }}><SubmitButton className="btn btn-solid btn-sm">Serve here instead</SubmitButton></RpcForm>
              </div>)
            : <div className="alert alert-err" style={{ marginTop: 12 }}>{other ? `This participant’s current step is ${other.participant_tasks.service_name} at ${other.stations.name} (${other.state.replace('_', ' ')}).` : 'This participant has no task assigned to this station.'} <Link href={`/e/${eventId}/participants/${scannedReg}`}>See their progress</Link></div>)
            : sp.scan ? <div style={{ marginTop: 12 }}><ScanMatches query={sp.scan} matches={matches} hrefFor={(id) => `${base}?at=${station.id}&reg=${id}`} /></div> : null}
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
