import { beforeAll, describe, expect, it } from 'vitest';
import { buildEvent, type Fixture } from '../../scripts/lib/fixture.ts';
import { activeAssignment, completeCurrent, db, must, newCode, register, rpcError, tasksOf } from './helpers.ts';

async function assertQueueIntegrity(eventId: string) {
  const qa = await must<{ registration_id: string; state: string; station_id: string; task_id: string }[]>(
    db().from('queue_assignments').select('registration_id, state, station_id, task_id').eq('event_id', eventId));
  const tasks = await must<{ id: string; service_id: string; location: string }[]>(
    db().from('participant_tasks').select('id, service_id, location').eq('event_id', eventId));
  const caps = await must<{ station_id: string; service_id: string }[]>(
    db().from('station_capabilities').select('station_id, service_id').eq('event_id', eventId));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const capSet = new Set(caps.map((c) => `${c.station_id}:${c.service_id}`));
  for (const q of qa) {
    const t = taskById.get(q.task_id)!;
    expect(t.location, 'walk-in task assigned to a station').toBe('event_day');
    expect(capSet.has(`${q.station_id}:${t.service_id}`), 'incompatible station assignment').toBe(true);
  }
  const active = new Map<string, number>();
  for (const q of qa.filter((x) => ['queued', 'called', 'in_service'].includes(x.state))) {
    active.set(q.registration_id, (active.get(q.registration_id) ?? 0) + 1);
  }
  expect(Math.max(0, ...active.values())).toBeLessThanOrEqual(1);
}

describe('station workflow', () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await buildEvent({ code: newCode('QUE') }); });

  it('completing tasks walks the participant through every event-day service, never the walk-in one', async () => {
    const r = await register(fx, 'male');
    const visited: string[] = [];
    for (let i = 0; i < 10; i++) {
      const a = await completeCurrent(fx, r.registration_id);
      if (!a) break;
      visited.push(a.station_id);
    }
    const tasks = await tasksOf(r.registration_id);
    expect(tasks.filter((t) => t.location === 'event_day').every((t) => t.status === 'completed')).toBe(true);
    expect(tasks.find((t) => t.location === 'walk_in')?.status).toBe('not_attended');
    expect(visited).toHaveLength(5);   // sample, ECG, X-Ray, BMD, body composition
    const att = await must<{ kind: string }[]>(db().from('task_attendance_events').select('kind').eq('registration_id', r.registration_id));
    expect(att.filter((a) => a.kind === 'completed')).toHaveLength(13);
    expect(att.filter((a) => a.kind === 'appeared')).toHaveLength(13);
    await assertQueueIntegrity(fx.eventId);
  });

  it('repeated completion is a no-op and does not inflate attendance', async () => {
    const r = await register(fx, 'female');
    const a = (await activeAssignment(r.registration_id))!;
    const staff = fx.users.station_staff.client;
    await must(staff.rpc('task_action', { p_task: a.task_id, p_action: 'start', p_station: a.station_id }));
    await must(staff.rpc('task_action', { p_task: a.task_id, p_action: 'complete', p_station: a.station_id }));
    const again = await must<{ already: boolean }>(staff.rpc('task_action', { p_task: a.task_id, p_action: 'complete', p_station: a.station_id }));
    expect(again.already).toBe(true);
    const att = await must<unknown[]>(db().from('task_attendance_events').select('id').eq('task_id', a.task_id).eq('kind', 'completed'));
    const lines = await must<unknown[]>(db().from('task_items').select('order_item_id').eq('task_id', a.task_id));
    expect(att.length).toBe(lines.length);
  });

  it('rejects illegal transitions and the wrong station', async () => {
    const r = await register(fx, 'female');
    const a = (await activeAssignment(r.registration_id))!;
    const staff = fx.users.station_staff.client;
    expect(await rpcError(staff.rpc('task_action', { p_task: a.task_id, p_action: 'complete', p_station: a.station_id })))
      .toMatch(/illegal_transition/);
    const other = Object.values(fx.stations).find((s) => s !== a.station_id && s !== fx.stations['WI-1'] &&
      ![fx.stations['REG-1'], fx.stations['REG-2'], fx.stations['ADD-1']].includes(s))!;
    expect(await rpcError(staff.rpc('task_action', { p_task: a.task_id, p_action: 'start', p_station: other })))
      .toMatch(/wrong_station/);
    expect(await rpcError(fx.users.addon_staff.client.rpc('task_action', { p_task: a.task_id, p_action: 'start', p_station: a.station_id })))
      .toMatch(/permission_denied/);
    // scanning alone never completes: a scan only resolves the registration
    await must(staff.rpc('resolve_scan', { p_event: fx.eventId, p_code: r.registration_code, p_token_hash: null, p_station: a.station_id }));
    const t = (await tasksOf(r.registration_id)).find((x) => x.id === a.task_id)!;
    expect(t.status).toBe('queued');
  });

  it('supervisors cannot reassign a task to an incompatible station', async () => {
    const r = await register(fx, 'male');
    const a = (await activeAssignment(r.registration_id))!;
    const tasks = await tasksOf(r.registration_id);
    const svcOfTask = tasks.find((t) => t.id === a.task_id)!.service_name;
    const incompatible = svcOfTask === 'X-Ray' ? fx.stations['ECG-1'] : fx.stations['XR-1'];
    expect(await rpcError(fx.users.station_supervisor.client.rpc('reassign_task',
      { p_task: a.task_id, p_target_station: incompatible, p_reason: 'test' }))).toMatch(/incompatible_station/);
    const walkin = tasks.find((t) => t.location === 'walk_in')!;
    expect(await rpcError(fx.users.station_supervisor.client.rpc('reassign_task',
      { p_task: walkin.id, p_target_station: fx.stations['ECG-1'], p_reason: 'test' }))).toMatch(/illegal_transition/);
  });

  it('parallel completions keep one active assignment per participant', async () => {
    const regs = await Promise.all(Array.from({ length: 12 }, (_, i) => register(fx, i % 2 ? 'male' : 'female')));
    for (let round = 0; round < 3; round++) {
      await Promise.all(regs.map((r) => completeCurrent(fx, r.registration_id)));
    }
    await assertQueueIntegrity(fx.eventId);
  });
});

describe('load balancing, pause and capacity', () => {
  let fx: Fixture;
  beforeAll(async () => {
    fx = await buildEvent({ code: newCode('LB') });
    // leave only the two ECG rooms open so every first assignment is an ECG task
    for (const code of ['S-01', 'S-02', 'S-03', 'XR-1', 'BMD-1', 'BC-1']) {
      await must(fx.users.station_supervisor.client.rpc('station_set_status',
        { p_station: fx.stations[code], p_status: 'paused', p_reason: 'test isolation' }));
    }
  });

  it('distributes compatible tasks to the lower-load station with deterministic tie-breaks', async () => {
    const got: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await register(fx, 'male');
      got.push((await activeAssignment(r.registration_id))!.station_id);
    }
    const [e1, e2] = [fx.stations['ECG-1'], fx.stations['ECG-2']];
    expect(got).toEqual([e1, e2, e1, e2]);
    const qa = await must<{ reason: string; score: { candidates: unknown[] } }[]>(
      db().from('queue_assignments').select('reason, score').eq('event_id', fx.eventId).limit(1));
    expect(qa[0].reason).toMatch(/lowest estimated wait/);
    expect(qa[0].score.candidates.length).toBeGreaterThan(0);
  });

  it('pausing a station moves its waiting tickets and stops new work', async () => {
    const sup = fx.users.station_supervisor.client;
    await must(sup.rpc('station_set_status', { p_station: fx.stations['ECG-1'], p_status: 'paused', p_reason: 'equipment check' }));
    const onE1 = await must<unknown[]>(db().from('queue_assignments').select('id')
      .eq('station_id', fx.stations['ECG-1']).in('state', ['queued', 'called']));
    expect(onE1).toHaveLength(0);
    const r = await register(fx, 'male');
    expect((await activeAssignment(r.registration_id))!.station_id).toBe(fx.stations['ECG-2']);
  });

  it('with no compatible open station the participant waits unassigned, then is picked up when one opens', async () => {
    const sup = fx.users.station_supervisor.client;
    await must(sup.rpc('station_set_status', { p_station: fx.stations['ECG-2'], p_status: 'closed', p_reason: 'end of shift' }));
    const r = await register(fx, 'male');
    expect(await activeAssignment(r.registration_id)).toBeUndefined();
    expect((await tasksOf(r.registration_id)).some((t) => t.status === 'waiting_unassigned')).toBe(true);
    await must(sup.rpc('station_set_status', { p_station: fx.stations['ECG-1'], p_status: 'open', p_reason: null }));
    expect((await activeAssignment(r.registration_id))?.station_id).toBe(fx.stations['ECG-1']);
    await assertQueueIntegrity(fx.eventId);
  });
});
