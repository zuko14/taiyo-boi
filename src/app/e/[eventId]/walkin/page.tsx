import Link from 'next/link';
import { DutyPicker } from '@/components/DutyPicker';
import { ReasonAction, RpcForm } from '@/components/RpcForm';
import { ScanBox } from '@/components/ScanBox';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, Empty, PageHead, SourceTag, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { myStations } from '@/lib/duty';
import { dt } from '@/lib/format';
import { resolveScan } from '@/lib/scan';

type Task = { id: string; service_id: string; service_name: string; source: string; status: string; status_reason: string | null; choice_group_id: string | null;
  external_accession: string | null; station_id: string | null; payment_intent_id: string | null; payment_exception: boolean;
  task_items: { order_items: { test_name: string; status: string } }[] };

export default async function Walkin({ params, searchParams }: { params: Promise<{ eventId: string }>; searchParams: Promise<{ at?: string; scan?: string; reg?: string }> }) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm(eventId, 'walkin.checkin', 'walkin.perform');
  const tz = ctx.event.timezone;
  const { stations } = await myStations(ctx, ['walkin_centre']);
  const at = sp.at ?? (stations.length === 1 ? stations[0].id : undefined);
  const base = `/e/${eventId}/walkin`;
  const centre = stations.find((s) => s.id === at);
  const regId = sp.reg ?? (await resolveScan(ctx, sp.scan, at));
  const back = `${base}?at=${at}${regId ? `&reg=${regId}` : ''}`;

  let panel = null; let pending = null;
  if (centre) {
    const { data: caps } = await ctx.supabase.from('station_capabilities').select('service_id').eq('station_id', centre.id);
    const svc = (caps ?? []).map((c) => c.service_id);
    if (regId) {
      const [{ data: reg }, { data: tasks }, { data: visits }] = await Promise.all([
        ctx.supabase.from('registrations').select('id, registration_code, status, participants(full_name), packages(name), package_configuration_versions(snapshot)').eq('id', regId).maybeSingle(),
        ctx.supabase.from('participant_tasks').select('id, service_id, service_name, source, status, status_reason, choice_group_id, external_accession, station_id, payment_intent_id, payment_exception, task_items(order_items(test_name, status))')
          .eq('registration_id', regId).eq('location', 'walk_in').order('created_at'),
        ctx.supabase.from('walkin_visits').select('id, visit_date, checked_in_at, stations:centre_id(name)').eq('registration_id', regId).order('checked_in_at', { ascending: false }),
      ]);
      const snap = (reg?.package_configuration_versions as unknown as { snapshot: { choice_groups: { id: string; name: string; rule: string }[]; tests: { test_id: string; name: string; choice_group_id: string | null }[] } } | undefined)?.snapshot;
      const list = ((tasks ?? []) as unknown as Task[]);
      const here = list.filter((t) => svc.includes(t.service_id));
      const elsewhere = list.filter((t) => !svc.includes(t.service_id));
      const act = (t: Task, action: string, label: string, cls = 'btn btn-ghost btn-sm') => (
        <RpcForm eventId={eventId} rpc="task_action" back={back} hidden={{ p_task: t.id, p_action: action, p_station: centre.id }}><SubmitButton className={cls}>{label}</SubmitButton></RpcForm>);
      panel = reg ? (
        <div className="grid grid-2">
          <Card title={`${reg.registration_code} · ${(reg.participants as unknown as { full_name: string }).full_name}`} sub={(reg.packages as unknown as { name: string }).name}
            actions={<Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/participants/${regId}`}>Participant</Link>}>
            {reg.status !== 'active' ? <div className="alert alert-err">Registration is {reg.status}.</div> : null}
            {here.length ? <ul className="list">{here.map((t) => {
              const group = t.choice_group_id ? snap?.choice_groups.find((g) => g.id === t.choice_group_id) : null;
              const opts = group ? snap!.tests.filter((x) => x.choice_group_id === group.id) : [];
              return (
                <li key={t.id} style={{ display: 'block' }}>
                  <div className="row-between"><span className="strong">{t.service_name}</span><span className="row"><SourceTag source={t.source} /><StatusBadge status={t.status} /></span></div>
                  <div className="small text2">{t.task_items.filter((i) => i.order_items.status === 'active').map((i) => i.order_items.test_name).join(', ') || 'No option selected yet'}</div>
                  {t.external_accession ? <div className="small muted">Reference: <span className="mono">{t.external_accession}</span></div> : null}
                  {group && group.rule !== 'bundled' && ['awaiting_choice', 'not_attended'].includes(t.status) && ctx.can('choice.select') ? (
                    <RpcForm eventId={eventId} rpc="select_choice" back={back} ok="Choice recorded" hidden={{ p_reg: regId, p_group: group.id }} className="row" style={{ marginTop: 8 }}>
                      <span className="small">{group.rule === 'one_of' ? 'Choose one:' : 'Choose one or more:'}</span>
                      {opts.map((o) => <label key={o.test_id} className="check small"><input type={group.rule === 'one_of' ? 'radio' : 'checkbox'} name="p_test_ids" value={o.test_id} required={group.rule === 'one_of'} />{o.name}</label>)}
                      <SubmitButton className="btn btn-ghost btn-sm">Record choice</SubmitButton>
                    </RpcForm>) : null}
                  <div className="row" style={{ marginTop: 8 }}>
                    {t.status === 'not_attended' ? act(t, 'checkin', 'Check in', 'btn btn-solid btn-sm') : null}
                    {t.status === 'checked_in' ? act(t, 'start', 'Start service', 'btn btn-solid btn-sm') : null}
                    {t.status === 'in_service' ? act(t, 'complete', 'Mark completed', 'btn btn-green btn-sm') : null}
                    {['not_attended', 'checked_in'].includes(t.status) ? <ReasonAction eventId={eventId} rpc="task_action" back={back} hidden={{ p_task: t.id, p_action: 'no_show', p_station: centre.id }} label="No-show" /> : null}
                    {['checked_in', 'in_service'].includes(t.status) ? <ReasonAction eventId={eventId} rpc="task_action" back={back} hidden={{ p_task: t.id, p_action: 'exception', p_station: centre.id }} label="Exception" danger /> : null}
                  </div>
                  {['checked_in', 'in_service', 'completed'].includes(t.status) ? (
                    <RpcForm eventId={eventId} rpc="set_external_accession" back={back} ok="Reference saved" hidden={{ p_task: t.id, p_station: centre.id }} className="row" style={{ marginTop: 8 }}>
                      <input className="input" name="p_accession" required maxLength={80} placeholder="External accession / reference no." defaultValue={t.external_accession ?? ''} style={{ flex: 1, padding: '7px 12px' }} aria-label="External accession" />
                      <button className="btn btn-ghost btn-sm">Save reference</button>
                    </RpcForm>) : null}
                </li>);
            })}</ul> : <Empty>No walk-in tests for this participant at this centre.</Empty>}
            {elsewhere.length ? <p className="small muted" style={{ marginTop: 10 }}>Other walk-in tests (not available at this centre): {elsewhere.map((t) => t.service_name).join(', ')}</p> : null}
            <p className="small muted" style={{ marginTop: 10 }}>Check-in records attendance only. Each test is completed separately after the service is performed.</p>
          </Card>
          <Card title="Visit history">
            <ul className="list">{(visits ?? []).map((v) => <li key={v.id}><span>{(v.stations as unknown as { name: string } | null)?.name}</span><span className="small muted">{dt(v.checked_in_at, tz)}</span></li>)}
              {!visits?.length ? <li className="muted">No visits yet.</li> : null}</ul>
          </Card>
        </div>
      ) : <Card><Empty>Registration not found.</Empty></Card>;
    } else {
      const { data: waiting, count } = await ctx.supabase.from('participant_tasks')
        .select('id, service_name, status, registration_id, registrations!inner(registration_code, status, participants(full_name))', { count: 'exact' })
        .eq('event_id', eventId).eq('location', 'walk_in').in('service_id', svc.length ? svc : ['00000000-0000-0000-0000-000000000000'])
        .in('status', ['not_attended', 'awaiting_choice', 'checked_in', 'in_service']).eq('registrations.status', 'active').order('created_at').limit(100);
      pending = (
        <Card title="Pending at this centre" sub={`${count ?? 0} test(s) outstanding`}>
          {waiting?.length ? <div className="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Service</th><th>Status</th></tr></thead>
            <tbody>{waiting.map((w) => { const r = w.registrations as unknown as { registration_code: string; participants: { full_name: string } }; return (
              <tr key={w.id}><td><Link className="mono strong" href={`${base}?at=${at}&reg=${w.registration_id}`}>{r.registration_code}</Link></td><td>{r.participants.full_name}</td><td>{w.service_name}</td><td><StatusBadge status={w.status} /></td></tr>); })}</tbody></table></div>
            : <Empty>Nothing pending.</Empty>}
        </Card>);
    }
  }

  return (
    <>
      <PageHead title={centre ? centre.name : 'Walk-in centre'} meta="Walk-in services are never sent to event-day queues." />
      <DutyPicker stations={stations} base={base} title="Centre" current={at} />
      {centre ? <Card><ScanBox action={base} hidden={{ at: centre.id }} /></Card> : null}
      {sp.scan && !regId ? <div className="alert alert-err">No registration found for that scan.</div> : null}
      {panel}{pending}
    </>
  );
}
