import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildEvent, type Fixture } from '../../scripts/lib/fixture.ts';
import { db, must, newCode } from './helpers.ts';

// Participants must never be left without a next step while the event is live:
// capacity freed by a completion, or an event resumed after a pause, re-queues them automatically.
let fx: Fixture;
beforeAll(async () => { fx = await buildEvent({ code: newCode('QREC') }); });

async function miniCamp(maxQueue: number | null = null) {
  const a = fx.platform.client;
  const ev = await must<string>(a.rpc('create_event', { p_code: newCode('QR'), p_name: 'Queue recovery camp' }));
  const svc = await must<{ id: string }>(a.from('workflow_services').insert({ event_id: ev, code: 'BLOOD', name: 'Blood draw', location: 'event_day' }).select('id').single());
  const t = await must<{ id: string }>(a.from('test_catalog').insert({ event_id: ev, code: 'CBC', display_name: 'CBC', location: 'event_day' }).select('id').single());
  await must(a.from('workflow_service_tests').insert({ event_id: ev, service_id: svc.id, test_id: t.id }));
  const pkg = await must<string>(a.rpc('create_package', { p_event: ev, p_code: 'BASIC', p_name: 'Basic', p_code_letter: 'B' }));
  await must(a.from('package_tests').insert({ event_id: ev, package_id: pkg, test_id: t.id }));
  const reg = (await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'R1', name: 'Reg', kind: 'registration_counter' }).select('id').single())).id;
  const b1 = (await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'B1', name: 'Blood 1', kind: 'station', max_queue: maxQueue }).select('id').single())).id;
  await must(a.from('station_capabilities').insert({ event_id: ev, station_id: b1, service_id: svc.id }));
  for (const [role, u] of [['registration_staff', fx.users.registration_staff], ['station_staff', fx.users.station_staff]] as const)
    await must(a.from('event_memberships').insert({ event_id: ev, user_id: u.id, role_code: role, created_by: fx.platform.id }));
  const start = new Date(Date.now() - 60_000).toISOString(); const end = new Date(Date.now() + 3600_000).toISOString();
  for (const s of [reg, b1]) {
    await must(a.rpc('assign_staff', { p_station: s, p_user: s === reg ? fx.users.registration_staff.id : fx.users.station_staff.id, p_start: start, p_end: end }));
    await must(a.rpc('station_set_status', { p_station: s, p_status: 'open', p_reason: null }));
  }
  await must(a.rpc('set_event_status', { p_event: ev, p_status: 'live', p_reason: null }));
  const register = async () => (await must<{ registration_id: string }>(fx.users.registration_staff.client.rpc('register_participant', {
    p_counter: reg, p_idempotency_key: randomUUID(), p_classification: 'basic', p_full_name: 'Synthetic Resident', p_consent: true }))).registration_id;
  return { ev, b1, register };
}

const active = async (r: string) => (await must<{ task_id: string; station_id: string; state: string }[]>(
  db().from('queue_assignments').select('task_id, station_id, state').eq('registration_id', r).in('state', ['queued', 'called', 'in_service'])))[0];
const act = (task: string, action: string, station: string) =>
  must(fx.users.station_staff.client.rpc('task_action', { p_task: task, p_action: action, p_station: station, p_reason: null }));

describe('queue recovery', () => {
  it('a full station frees a place → the waiting participant is queued without anyone refreshing', async () => {
    const c = await miniCamp(1);
    const p1 = await c.register();
    const p2 = await c.register();
    expect((await active(p1)).state).toBe('called');
    expect(await active(p2)).toBeUndefined();                // station full: waiting_unassigned
    const a1 = await active(p1);
    await act(a1.task_id, 'start', c.b1);
    await act(a1.task_id, 'complete', c.b1);
    expect(await active(p2)).toMatchObject({ station_id: c.b1, state: 'called' });
  });

  it('a station closed while the event was paused → participants are re-queued when the event goes live again', async () => {
    const c = await miniCamp();
    const a = fx.platform.client;
    const p = await c.register();
    expect((await active(p)).state).toBe('called');
    await must(a.rpc('set_event_status', { p_event: c.ev, p_status: 'paused', p_reason: 'Lunch break (synthetic)' }));
    await must(a.rpc('station_set_status', { p_station: c.b1, p_status: 'closed', p_reason: 'Machine check (synthetic)' }));
    expect(await active(p)).toBeUndefined();
    await must(a.rpc('station_set_status', { p_station: c.b1, p_status: 'open', p_reason: null }));
    await must(a.rpc('set_event_status', { p_event: c.ev, p_status: 'live', p_reason: 'Back from lunch (synthetic)' }));
    expect(await active(p)).toMatchObject({ station_id: c.b1, state: 'called' });
  });
});
