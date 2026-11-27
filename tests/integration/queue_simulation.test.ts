import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildEvent, type Fixture } from '../../scripts/lib/fixture.ts';
import { db, must, newCode } from './helpers.ts';

// Camp-day simulation on the BOI template (3 sample, 2 ECG, X-Ray, BMD, Body comp; one technician each).
// After every registration and every completion, the automatic queue must hold these invariants:
//   I1 at most one active ticket per participant
//   I2 a ticket is only ever at a station that performs that service, and never for a walk-in task
//   I3 a station never has more people called / in service than staff on shift
//   I4 no station sits idle while a participant it could serve is queued
//   I5 nobody with an outstanding event-day task is left without a ticket (all stations are open)
// and at the end every event-day package task is completed exactly once and walk-in tasks are untouched.
let fx: Fixture;
const N = 40;
beforeAll(async () => { fx = await buildEvent({ code: newCode('SIM') }); }, 120_000);

type QA = { id: string; registration_id: string; station_id: string; state: string; task_id: string };
type Task = { id: string; registration_id: string; service_id: string; location: string; status: string; payment_intent_id: string | null };

async function snapshot() {
  const [qa, tasks, caps] = await Promise.all([
    must<QA[]>(db().from('queue_assignments').select('id, registration_id, station_id, state, task_id').eq('event_id', fx.eventId).in('state', ['queued', 'called', 'in_service'])),
    must<Task[]>(db().from('participant_tasks').select('id, registration_id, service_id, location, status, payment_intent_id').eq('event_id', fx.eventId)),
    must<{ station_id: string; service_id: string }[]>(db().from('station_capabilities').select('station_id, service_id').eq('event_id', fx.eventId)),
  ]);
  return { qa, tasks, caps };
}

async function checkInvariants(step: string) {
  const { qa, tasks, caps } = await snapshot();
  const can = new Set(caps.map((c) => `${c.station_id}:${c.service_id}`));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const perReg = new Map<string, number>();
  for (const q of qa) perReg.set(q.registration_id, (perReg.get(q.registration_id) ?? 0) + 1);
  expect([...perReg.values()].every((n) => n === 1), `${step}: I1 one ticket per participant`).toBe(true);
  for (const q of qa) {
    const t = taskById.get(q.task_id)!;
    expect(t.location, `${step}: I2 walk-in task at a station`).toBe('event_day');
    expect(can.has(`${q.station_id}:${t.service_id}`), `${step}: I2 incompatible station`).toBe(true);
  }
  const stations = Object.entries(fx.stations).filter(([code]) => /^(S|ECG|XR|BMD|BC)-/.test(code)).map(([, id]) => id);
  for (const s of stations) {
    const busy = qa.filter((q) => q.station_id === s && ['called', 'in_service'].includes(q.state)).length;
    expect(busy, `${step}: I3 over capacity`).toBeLessThanOrEqual(1);
    if (busy === 0) {
      const couldServe = qa.some((q) => q.state === 'queued' && can.has(`${s}:${taskById.get(q.task_id)!.service_id}`));
      expect(couldServe, `${step}: I4 idle station while a compatible participant waits`).toBe(false);
    }
  }
  const withTicket = new Set(qa.map((q) => q.registration_id));
  const stranded = tasks.filter((t) => t.location === 'event_day' && ['not_ready', 'waiting_unassigned'].includes(t.status)
    && !t.payment_intent_id && !withTicket.has(t.registration_id));
  expect(stranded.map((t) => t.registration_id), `${step}: I5 participant left without a next step`).toEqual([]);
}

const staff = () => fx.users.station_staff.client;
const act = (task: string, action: string, station: string) =>
  must(staff().rpc('task_action', { p_task: task, p_action: action, p_station: station, p_reason: null }));

describe('camp-day queue simulation', () => {
  it(`${N} participants flow through every station with all invariants held at every step`, async () => {
    const regs: string[] = [];
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < N; i++) {
      const r = await must<{ registration_id: string }>(fx.users.registration_staff.client.rpc('register_participant', {
        p_counter: fx.stations[i % 2 ? 'REG-2' : 'REG-1'], p_idempotency_key: randomUUID(), p_classification: i % 3 ? 'female' : 'male',
        p_full_name: `Synthetic Employee ${i}`, p_age: 30 + (i % 25), p_consent: true }));
      regs.push(r.registration_id);
      if (i % 5 === 4) await checkInvariants(`after registration ${i + 1}`);
    }
    await checkInvariants('all registered');

    // serve called participants in random order (start then complete), sometimes finishing two at once
    for (let step = 0; step < 2000; step++) {
      const called = await must<QA[]>(db().from('queue_assignments').select('id, registration_id, station_id, state, task_id')
        .eq('event_id', fx.eventId).in('state', ['called', 'in_service']));
      if (!called.length) break;
      const q = called[rand(called.length)];
      if (q.state === 'called') await act(q.task_id, 'start', q.station_id);
      await act(q.task_id, 'complete', q.station_id);
      if (step % 4 === 0) await checkInvariants(`completion ${step}`);
    }
    await checkInvariants('end');

    const { qa, tasks } = await snapshot();
    expect(qa).toHaveLength(0);
    const eventDay = tasks.filter((t) => t.location === 'event_day');
    expect(eventDay.length).toBeGreaterThanOrEqual(N * 4);              // the simulation really served every visit
    expect(eventDay.filter((t) => t.status !== 'completed')).toEqual([]);
    expect(tasks.filter((t) => t.location === 'walk_in').every((t) => ['not_attended', 'awaiting_choice'].includes(t.status))).toBe(true);
    // per-test attendance: exactly one 'completed' record per completed order line, no inflation
    const att = await must<{ order_item_id: string; kind: string }[]>(db().from('task_attendance_events').select('order_item_id, kind').eq('event_id', fx.eventId).eq('kind', 'completed'));
    expect(new Set(att.map((a) => a.order_item_id)).size).toBe(att.length);
    // every participant was given a ticket number and served in station order (seq unique per station)
    const all = await must<{ station_id: string; seq: number; state: string }[]>(db().from('queue_assignments').select('station_id, seq, state').eq('event_id', fx.eventId));
    const keys = all.map((a) => `${a.station_id}:${a.seq}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(regs).toHaveLength(N);
  }, 600_000);
});
