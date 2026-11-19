import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildEvent, type Fixture } from '../../scripts/lib/fixture.ts';
import { db, must, newCode } from './helpers.ts';

// One service (blood draw), two identical stations with one technician each: fully automatic flow.
let fx: Fixture; let ev: string; let reg: string; let B1: string; let B2: string;
beforeAll(async () => {
  fx = await buildEvent({ code: newCode('AUTOQ') });
  const a = fx.platform.client;
  ev = await must<string>(a.rpc('create_event', { p_code: newCode('AQ'), p_name: 'Auto queue camp' }));
  const svc = await must<{ id: string }>(a.from('workflow_services').insert({ event_id: ev, code: 'BLOOD', name: 'Blood draw', location: 'event_day' }).select('id').single());
  const t = await must<{ id: string }>(a.from('test_catalog').insert({ event_id: ev, code: 'CBC', display_name: 'CBC', location: 'event_day' }).select('id').single());
  await must(a.from('workflow_service_tests').insert({ event_id: ev, service_id: svc.id, test_id: t.id }));
  const pkg = await must<string>(a.rpc('create_package', { p_event: ev, p_code: 'BASIC', p_name: 'Basic', p_code_letter: 'B' }));
  await must(a.from('package_tests').insert({ event_id: ev, package_id: pkg, test_id: t.id }));
  reg = (await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'R1', name: 'Reg', kind: 'registration_counter' }).select('id').single())).id;
  B1 = (await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'B1', name: 'Blood 1', kind: 'station' }).select('id').single())).id;
  B2 = (await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'B2', name: 'Blood 2', kind: 'station' }).select('id').single())).id;
  for (const s of [B1, B2]) await must(a.from('station_capabilities').insert({ event_id: ev, station_id: s, service_id: svc.id }));
  for (const [role, u] of [['registration_staff', fx.users.registration_staff], ['station_staff', fx.users.station_staff]] as const)
    await must(a.from('event_memberships').insert({ event_id: ev, user_id: u.id, role_code: role, created_by: fx.platform.id }));
  const start = new Date(Date.now() - 60_000).toISOString(); const end = new Date(Date.now() + 3600_000).toISOString();
  for (const s of [reg, B1, B2]) {
    await must(a.rpc('assign_staff', { p_station: s, p_user: s === reg ? fx.users.registration_staff.id : fx.users.station_staff.id, p_start: start, p_end: end }));
    await must(a.rpc('station_set_status', { p_station: s, p_status: 'open', p_reason: null }));
  }
  await must(a.rpc('set_event_status', { p_event: ev, p_status: 'live', p_reason: null }));
});

const registerOne = async () => (await must<{ registration_id: string }>(fx.users.registration_staff.client.rpc('register_participant', {
  p_counter: reg, p_idempotency_key: randomUUID(), p_classification: 'basic', p_full_name: 'Synthetic Resident', p_consent: true }))).registration_id;
const active = async (r: string) => (await must<{ id: string; task_id: string; station_id: string; state: string; reason: string }[]>(
  db().from('queue_assignments').select('id, task_id, station_id, state, reason').eq('registration_id', r).in('state', ['queued', 'called', 'in_service'])))[0];
const load = async () => {
  const rows = await must<{ station_id: string; state: string }[]>(db().from('queue_assignments').select('station_id, state').eq('event_id', ev).in('state', ['queued', 'called', 'in_service']));
  const of = (s: string, st: string) => rows.filter((r) => r.station_id === s && r.state === st).length;
  return { B1: { called: of(B1, 'called'), queued: of(B1, 'queued'), serving: of(B1, 'in_service') }, B2: { called: of(B2, 'called'), queued: of(B2, 'queued'), serving: of(B2, 'in_service') } };
};
const act = (task: string, action: string, station: string) => must(fx.users.station_staff.client.rpc('task_action', { p_task: task, p_action: action, p_station: station, p_reason: null }));

describe('automatic queue flow (no Call next)', () => {
  it('spreads participants by load and calls one per free station automatically', async () => {
    const p1 = await registerOne(); const p2 = await registerOne();
    expect((await active(p1)).state).toBe('called');
    expect((await active(p2)).state).toBe('called');
    expect((await active(p1)).station_id).not.toBe((await active(p2)).station_id);   // least-loaded station
    const p3 = await registerOne(); const p4 = await registerOne();
    expect(await load()).toEqual({ B1: { called: 1, queued: 1, serving: 0 }, B2: { called: 1, queued: 1, serving: 0 } });
    expect((await active(p3)).station_id).not.toBe((await active(p4)).station_id);
    // finishing at a station calls the next person in its queue with no staff action
    const a1 = await active(p1);
    await act(a1.task_id, 'start', a1.station_id);
    await act(a1.task_id, 'complete', a1.station_id);
    const next = [await active(p3), await active(p4)].find((x) => x.station_id === a1.station_id)!;
    expect(next.state).toBe('called');
    // clean up: finish everyone
    for (const p of [p2, p3, p4]) { const x = await active(p); if (x) { await act(x.task_id, 'start', x.station_id); await act(x.task_id, 'complete', x.station_id); } }
    expect(await load()).toEqual({ B1: { called: 0, queued: 0, serving: 0 }, B2: { called: 0, queued: 0, serving: 0 } });
  });

  it('an idle station takes over the longest-waiting participant from a busy one', async () => {
    const pa = await registerOne(); const pb = await registerOne();      // both called, one per station
    const pc = await registerOne();                                      // queued behind one of them
    const c = await active(pc);
    expect(c.state).toBe('queued');
    const other = c.station_id === B1 ? B2 : B1;
    const free = [await active(pa), await active(pb)].find((x) => x.station_id === other)!;
    await act(free.task_id, 'start', other);
    await act(free.task_id, 'complete', other);                         // `other` is now idle with an empty queue
    const moved = await active(pc);
    expect(moved).toMatchObject({ station_id: other, state: 'called' });
    expect(moved.reason).toMatch(/Automatically moved/);
    const audit = await must<unknown[]>(db().from('audit_logs').select('id').eq('event_id', ev).eq('action', 'queue.auto_move').eq('entity_id', c.task_id));
    expect(audit).toHaveLength(1);
    for (const p of [pa, pb, pc]) { const x = await active(p); if (x) { if (x.state !== 'in_service') await act(x.task_id, 'start', x.station_id); await act(x.task_id, 'complete', x.station_id); } }
  });

  it('a no-show frees the slot and the next participant is called', async () => {
    const ids = [await registerOne(), await registerOne(), await registerOne()];
    const queued = (await Promise.all(ids.map(active))).find((x) => x.state === 'queued')!;
    const blocker = (await Promise.all(ids.map(active))).find((x) => x.state === 'called' && x.station_id === queued.station_id)!;
    await must(fx.users.station_staff.client.rpc('task_action', { p_task: blocker.task_id, p_action: 'no_show', p_station: blocker.station_id, p_reason: 'did not come' }));
    expect((await must<{ state: string }>(db().from('queue_assignments').select('state').eq('id', queued.id).single())).state).toBe('called');
    for (const p of ids) { const x = await active(p); if (x) { await act(x.task_id, 'start', x.station_id); await act(x.task_id, 'complete', x.station_id); } }
  });

  it('parallel registrations never call more people than a station has staff', async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, registerOne));
    const l = await load();
    expect(l.B1.called + l.B1.serving).toBe(1);
    expect(l.B2.called + l.B2.serving).toBe(1);
    expect(l.B1.queued + l.B2.queued).toBe(6);
    expect(Math.abs(l.B1.queued - l.B2.queued)).toBeLessThanOrEqual(1);    // balanced
    const per = await must<{ registration_id: string }[]>(db().from('queue_assignments').select('registration_id').in('registration_id', ids).in('state', ['queued', 'called', 'in_service']));
    expect(new Set(per.map((x) => x.registration_id)).size).toBe(per.length);  // one active ticket each
  });
});
