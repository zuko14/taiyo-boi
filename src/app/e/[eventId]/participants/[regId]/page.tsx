import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Icon } from '@/components/Icons';
import { LiveRefresh } from '@/components/LiveRefresh';
import { ReasonAction, RpcForm } from '@/components/RpcForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, PageHead, SourceTag, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { env } from '@/lib/env';
import { classLabel, dt, inr, locationLabel } from '@/lib/format';

type Item = { id: string; test_name: string; test_code: string; source: string; status: string; unit_price_paise: number; location: string };
type Task = { id: string; service_name: string; location: string; source: string; status: string; status_reason: string | null;
  choice_group_id: string | null; payment_intent_id: string | null; payment_exception: boolean; external_accession: string | null;
  stations: { name: string; code: string } | null; task_items: { order_items: Item }[] };
type Snapshot = { choice_groups: { id: string; name: string; rule: string }[]; tests: { test_id: string; name: string; choice_group_id: string | null }[] };

export default async function ParticipantDetail({ params }: { params: Promise<{ eventId: string; regId: string }> }) {
  const { eventId, regId } = await params;
  const ctx = await requirePerm(eventId, 'participant.view');
  const tz = ctx.event.timezone;
  const back = `/e/${eventId}/participants/${regId}`;

  const { data: reg } = await ctx.supabase.from('registrations')
    .select('*, participants(*), packages(name), package_configuration_versions(snapshot, created_at)').eq('id', regId).eq('event_id', eventId).maybeSingle();
  if (!reg) notFound();
  const p = reg.participants as { full_name: string; age: number | null; employee_id: string | null; mobile: string | null; email: string | null; department: string | null };
  const snap = (reg.package_configuration_versions as { snapshot: Snapshot }).snapshot;

  const [{ data: tasksRaw }, { data: queue }, { data: prints }, payments, reports] = await Promise.all([
    ctx.supabase.from('participant_tasks').select('*, stations(name, code), task_items(order_items(id, test_name, test_code, source, status, unit_price_paise, location))')
      .eq('registration_id', regId).order('location').order('created_at'),
    ctx.supabase.from('queue_assignments').select('*, stations(name, code)').eq('registration_id', regId).order('assigned_at', { ascending: false }).limit(20),
    ctx.supabase.from('tag_prints').select('*').eq('registration_id', regId).order('created_at'),
    ctx.can('payment.view', 'finance.view')
      ? ctx.supabase.from('payment_intents').select('*, receipts(receipt_no)').eq('registration_id', regId).order('created_at') : Promise.resolve({ data: null }),
    ctx.can('report.view') ? ctx.supabase.from('reports').select('id, title, status, version, order_item_id, published_at').eq('registration_id', regId) : Promise.resolve({ data: null }),
  ]);
  const tasks = (tasksRaw ?? []) as Task[];
  const active = (queue ?? []).find((q) => ['queued', 'called', 'in_service'].includes(q.state));
  const pkgTasks = tasks.filter((t) => t.source === 'package');
  const addonTasks = tasks.filter((t) => t.source === 'addon');
  const reportFor = (itemId: string) => (reports.data ?? []).filter((r) => r.order_item_id === itemId).sort((a, b) => b.version - a.version)[0];

  const taskRow = (t: Task) => {
    const group = t.choice_group_id ? snap.choice_groups.find((g) => g.id === t.choice_group_id) : null;
    const options = group ? snap.tests.filter((x) => x.choice_group_id === group.id) : [];
    return (
      <li key={t.id} style={{ display: 'block' }}>
        <div className="row-between">
          <div><span className="strong">{t.service_name}</span> <span className="small muted">· {locationLabel(t.location)}{t.stations ? ` · ${t.stations.name}` : ''}</span></div>
          <div className="row"><StatusBadge status={t.status} />{t.payment_intent_id && t.payment_exception ? <span className="badge amber">payment exception</span> : null}</div>
        </div>
        {t.status_reason ? <div className="small muted">{t.status_reason}</div> : null}
        <div className="row small text2" style={{ gap: 6, marginTop: 4 }}>
          {t.task_items.filter((ti) => ti.order_items.status === 'active').map(({ order_items: i }) => {
            const rp = reportFor(i.id);
            return <span key={i.id} className="badge plain" title={rp ? `Report v${rp.version}: ${rp.status}` : 'No report yet'}>{i.test_name}{rp ? ` · ${rp.status === 'published' ? 'report ✓' : 'report …'}` : ''}</span>;
          })}
        </div>
        {group && ctx.can('choice.select') && ['awaiting_choice', 'not_attended', 'not_ready'].includes(t.status) && group.rule !== 'bundled' ? (
          <RpcForm eventId={eventId} rpc="select_choice" back={back} ok="Choice recorded" hidden={{ p_reg: regId, p_group: group.id }} className="row" style={{ marginTop: 8 }}>
            <span className="small text2">{group.rule === 'one_of' ? 'Participant chooses one:' : 'Participant chooses one or more:'}</span>
            {options.map((o) => (
              <label key={o.test_id} className="check small"><input type={group.rule === 'one_of' ? 'radio' : 'checkbox'} name="p_test_ids" value={o.test_id} required={group.rule === 'one_of'} />{o.name}</label>
            ))}
            <SubmitButton className="btn btn-ghost btn-sm">Record choice</SubmitButton>
          </RpcForm>
        ) : null}
        <div className="row" style={{ marginTop: 8 }}>
          {ctx.can('task.skip') && ['not_ready', 'waiting_unassigned', 'queued', 'called'].includes(t.status) && t.location === 'event_day'
            ? <ReasonAction eventId={eventId} rpc="task_action" back={back} hidden={{ p_task: t.id, p_action: 'skip' }} label="Skip" /> : null}
          {ctx.can('task.skip') && !['completed', 'cancelled', 'in_service', 'skipped'].includes(t.status)
            ? <ReasonAction eventId={eventId} rpc="task_action" back={back} hidden={{ p_task: t.id, p_action: 'cancel' }} label="Cancel" danger /> : null}
          {ctx.can('queue.override') && ['no_show', 'exception', 'waiting_unassigned', 'skipped'].includes(t.status)
            ? <ReasonAction eventId={eventId} rpc="task_action" back={back} hidden={{ p_task: t.id, p_action: 'requeue' }} label="Requeue" /> : null}
          {ctx.can('payment.exception') && t.payment_intent_id && !t.payment_exception && ['not_ready', 'not_attended'].includes(t.status)
            ? <ReasonAction eventId={eventId} rpc="grant_payment_exception" back={back} hidden={{ p_task: t.id }} label="Allow before payment" /> : null}
        </div>
      </li>
    );
  };

  return (
    <>
      <PageHead title={`${reg.registration_code}`} meta={<>{p.full_name} · {classLabel(reg.classification)} · {(reg.packages as { name: string }).name} · registered {dt(reg.created_at, tz)}</>}>
        <LiveRefresh eventId={eventId} tables={['queue_assignments', 'participant_tasks']} url={env().NEXT_PUBLIC_SUPABASE_URL} anonKey={env().NEXT_PUBLIC_SUPABASE_ANON_KEY} pollMs={20000} />
        {reg.status !== 'active' ? <StatusBadge status={reg.status} /> : null}
        <Link className="btn btn-ghost btn-sm" href={`${back}/tag`}><Icon name="printer" />{reg.tag_version ? 'Reprint tag' : 'Print tag'}</Link>
        {ctx.can('addon.create') ? <Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/addons?reg=${regId}`}><Icon name="plus" />Add-ons</Link> : null}
      </PageHead>
      {reg.classification_override_reason ? <div className="alert alert-warn">Package override: {reg.classification_override_reason}</div> : null}

      <section className="glass next-step">
        <div className="eyebrow">Current step</div>
        {active ? (
          <>
            <div className="where">{tasks.find((t) => t.id === active.task_id)?.service_name} — {active.stations?.name}</div>
            <div className="row"><StatusBadge status={active.state} /><span className="small muted">Ticket #{active.seq} · {active.reason}</span></div>
          </>
        ) : <div className="where" style={{ fontSize: '1.2rem' }}>{pkgTasks.some((t) => t.location === 'event_day' && !['completed', 'skipped', 'cancelled'].includes(t.status)) ? 'Waiting for the next available station' : 'No event-day step pending'}</div>}
      </section>

      <div className="grid grid-2">
        <div>
          <Card title="Sponsored package" sub={<><SourceTag source="package" /> <span className="small muted">Snapshot of the package at registration</span></>}>
            <ul className="list">{pkgTasks.map(taskRow)}</ul>
          </Card>
          <Card title="Add-on tests" sub={<SourceTag source="addon" />} actions={ctx.can('addon.create') ? <Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/addons?reg=${regId}`}>Add tests</Link> : null}>
            {addonTasks.length ? <ul className="list">{addonTasks.map(taskRow)}</ul> : <p className="muted small">No add-ons.</p>}
            {payments.data?.length ? (<><div className="hr" /><div className="label">Payments</div><ul className="list">
              {payments.data.map((i) => (
                <li key={i.id}><span>{inr(i.amount_paise)}{i.refunded_paise ? ` (refunded ${inr(i.refunded_paise)})` : ''}</span>
                  <span className="row"><StatusBadge status={i.status} />{(i.receipts as { receipt_no: string } | null)?.receipt_no ? <Link className="small" href={`/e/${eventId}/receipts/${i.id}`}>{(i.receipts as { receipt_no: string }).receipt_no}</Link> : null}
                    {ctx.can('payment.verify') && ['pending', 'requires_review'].includes(i.status) ? <Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/payments?intent=${i.id}`}>Verify</Link> : null}</span></li>))}
            </ul></>) : null}
          </Card>
        </div>
        <div>
          <Card title="Participant">
            <dl className="kv">
              <dt>Name</dt><dd>{p.full_name}</dd><dt>Age</dt><dd>{p.age ?? '—'}</dd><dt>Employee ID</dt><dd>{p.employee_id ?? '—'}</dd>
              <dt>Mobile</dt><dd>{p.mobile ? `******${p.mobile.slice(-4)}` : '—'}</dd><dt>Appeared</dt><dd>{dt(reg.arrived_at, tz)}</dd>
              <dt>Tag</dt><dd>{reg.tag_version ? `v${reg.tag_version} · ${reg.tag_printed_confirmed_at ? 'print confirmed' : 'print not confirmed'}` : 'not printed'}</dd>
            </dl>
            {ctx.can('registration.correct') ? (
              <details style={{ marginTop: 14 }}><summary className="small text2" style={{ cursor: 'pointer' }}>Correct details (audited)</summary>
                <RpcForm eventId={eventId} rpc="correct_registration" back={back} ok="Details corrected" hidden={{ p_reg: regId }} style={{ marginTop: 10 }}>
                  <div className="field"><label>Full name</label><input name="p_full_name" defaultValue={p.full_name} required /></div>
                  <div className="form-row">
                    <div className="field"><label>Age</label><input name="p_age" type="number" defaultValue={p.age ?? ''} /></div>
                    <div className="field"><label>Employee ID</label><input name="p_employee_id" defaultValue={p.employee_id ?? ''} /></div>
                    <div className="field"><label>Mobile</label><input name="p_mobile" pattern="[0-9]{10}" defaultValue={p.mobile ?? ''} /></div>
                  </div>
                  <input type="hidden" name="p_email" value={p.email ?? ''} /><input type="hidden" name="p_department" value={p.department ?? ''} />
                  <div className="field"><label>Reason</label><input name="p_reason" required /></div>
                  <SubmitButton className="btn btn-ghost btn-sm">Save correction</SubmitButton>
                </RpcForm>
              </details>) : null}
          </Card>

          <Card title="Tag and portal access">
            <ul className="list">{(prints ?? []).map((t) => <li key={t.id}><span>v{t.tag_version} · {t.kind}{t.reason ? ` — ${t.reason}` : ''}</span><span className="small muted">{dt(t.created_at, tz)}</span></li>)}
              {!prints?.length ? <li className="muted">No tag issued yet.</li> : null}</ul>
            {ctx.can('tag.revoke') && reg.tag_version ? <div style={{ marginTop: 12 }}><ReasonAction eventId={eventId} rpc="revoke_tag" back={back} hidden={{ p_reg: regId }} label="Revoke lost tag" danger ok="Tag revoked — old QR no longer works" /></div> : null}
          </Card>

          {ctx.can('registration.duplicate_resolve', 'live_configuration.override') && reg.status === 'active' ? (
            <Card title="Supervisor actions">
              {ctx.can('registration.duplicate_resolve') ? (
                <RpcForm eventId={eventId} rpc="resolve_duplicate" back={back} ok="Marked as duplicate" hidden={{ p_duplicate: regId }}>
                  <div className="form-row">
                    <div className="field"><label>Keep registration (ID)</label><input name="p_keep" required placeholder="UUID of the registration to keep" /></div>
                    <div className="field"><label>Reason</label><input name="p_reason" required /></div>
                  </div>
                  <SubmitButton className="btn btn-red btn-sm" confirm="Void this registration as a duplicate? Nothing is deleted.">Void as duplicate</SubmitButton>
                </RpcForm>) : null}
              {ctx.can('live_configuration.override') ? (<><div className="hr" />
                <p className="small muted">Migrate this registration to the current package configuration: adds new package tests, cancels removed tests that have not started.</p>
                <ReasonAction eventId={eventId} rpc="migrate_registration_config" back={back} hidden={{ p_reg: regId }} label="Migrate configuration" ok="Configuration migrated" /></>) : null}
            </Card>) : null}

          <Card title="Queue history" sub="Why each station was chosen">
            <ul className="list">{(queue ?? []).map((q) => (
              <li key={q.id} style={{ display: 'block' }}><div className="row-between"><span>{q.stations?.name} · #{q.seq}</span><StatusBadge status={q.state} /></div>
                <div className="small muted">{dt(q.assigned_at, tz, false)} · {q.reason}</div></li>))}
              {!queue?.length ? <li className="muted">No assignments yet.</li> : null}</ul>
          </Card>
        </div>
      </div>
    </>
  );
}
