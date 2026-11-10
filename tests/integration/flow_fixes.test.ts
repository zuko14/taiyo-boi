// Regression tests for the end-to-end audit fixes (migrations 009/010).
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildEvent, type Fixture } from '../../scripts/lib/fixture.ts';
import { activeAssignment, completeCurrent, db, must, newCode, register, rpcError, tasksOf } from './helpers.ts';

let fx: Fixture;
beforeAll(async () => {
  fx = await buildEvent({ code: newCode('FLOW'), live: false });
  const admin = fx.users.event_admin.client;
  for (const t of ['CA-125', 'T3', 'PSA']) await must(admin.from('test_catalog').update({ addon_available: true }).eq('id', fx.tests[t]));
  await must(admin.from('addon_prices').insert({ event_id: fx.eventId, test_id: fx.tests['CA-125'], price_paise: 60000 }));
  await must(admin.from('addon_prices').insert({ event_id: fx.eventId, test_id: fx.tests.PSA, price_paise: 40000 }));
  // T3: no prepayment required, so its task is eligible immediately
  await must(admin.from('addon_prices').insert({ event_id: fx.eventId, test_id: fx.tests.T3, price_paise: 20000, require_payment_before_service: false }));
  await must(admin.from('workflow_service_tests').update({ completion_rule: 'manual_confirm' }).eq('test_id', fx.tests.PSA));
  await must(admin.from('workflow_service_tests').update({ completion_rule: 'manual_confirm' }).eq('test_id', fx.tests.ECG));
  await must(admin.rpc('set_event_status', { p_event: fx.eventId, p_status: 'live' }));
});

const order = (regId: string, tests: string[]) => must<{ order_id: string; intent_id: string }>(
  fx.users.addon_staff.client.rpc('create_addon_order', { p_reg: regId, p_desk: fx.stations['ADD-1'],
    p_test_ids: tests.map((t) => fx.tests[t]), p_idempotency_key: randomUUID(), p_consent: true }));
const pay = (intent: string) => must(fx.users.cashier.client.rpc('verify_payment',
  { p_intent: intent, p_method: 'cash', p_provider_ref: null, p_amount_paise: 60000 }));
const serviceOf = async (taskId: string) => (await must<{ service_id: string }>(db().from('participant_tasks').select('service_id').eq('id', taskId).single())).service_id;
const finishAll = async (regId: string) => { for (let i = 0; i < 10; i++) if (!(await completeCurrent(fx, regId))) break; };
const sampleAssignments = async (regId: string) => (await must<{ id: string }[]>(db().from('queue_assignments')
  .select('id, participant_tasks!inner(service_id)').eq('registration_id', regId).eq('participant_tasks.service_id', fx.services.SAMPLE)));

describe('add-on in the same service as a package test', () => {
  it('a paid add-on is completed in the same sample-collection visit — no second queue visit', async () => {
    const r = await register(fx, 'male');
    const o = await order(r.registration_id, ['CA-125']);
    await pay(o.intent_id);
    await finishAll(r.registration_id);
    const tasks = await tasksOf(r.registration_id);
    expect(tasks.filter((t) => t.status !== 'completed')).toEqual([expect.objectContaining({ location: 'walk_in' })]);
    expect(await sampleAssignments(r.registration_id)).toHaveLength(1);
    const ca = await must<{ kind: string }[]>(db().from('task_attendance_events').select('kind')
      .eq('registration_id', r.registration_id).eq('test_id', fx.tests['CA-125']));
    expect(ca.map((x) => x.kind).sort()).toEqual(['appeared', 'completed']);
  });

  it('an unpaid add-on is not included; it stays waiting for payment', async () => {
    const r = await register(fx, 'male');
    await order(r.registration_id, ['CA-125']);
    await finishAll(r.registration_id);
    const addon = (await tasksOf(r.registration_id)).find((t) => t.source === 'addon')!;
    expect(addon.status).toBe('not_ready');
    expect(await activeAssignment(r.registration_id)).toBeUndefined();
  });

  it('add-on order lines keep the service completion rule', async () => {
    const r = await register(fx, 'female');
    const o = await order(r.registration_id, ['PSA']);
    const items = await must<{ completion_rule: string }[]>(db().from('order_items').select('completion_rule').eq('order_id', o.order_id));
    expect(items).toEqual([{ completion_rule: 'manual_confirm' }]);
  });
});

describe('cancelling an add-on', () => {
  it('ends its queue ticket so the participant is not blocked', async () => {
    const r = await register(fx, 'male');
    await finishAll(r.registration_id);
    const o = await order(r.registration_id, ['T3']);          // no prepayment → queued at once
    const a = await activeAssignment(r.registration_id);
    expect(a).toBeDefined();
    await must(fx.users.addon_staff.client.rpc('payment_action', { p_intent: o.intent_id, p_action: 'cancel', p_reason: 'changed mind' }));
    expect(await activeAssignment(r.registration_id)).toBeUndefined();
    const t = (await tasksOf(r.registration_id)).find((x) => x.source === 'addon')!;
    expect(t.status).toBe('cancelled');
  });
});

describe('manual-confirm test lines', () => {
  it('completing the visit does not record completion; the technician confirms it at the right station', async () => {
    const r = await register(fx, 'female');
    let ecg: { task_id: string; station_id: string } | undefined;
    for (let i = 0; i < 10 && !ecg; i++) {
      const a = await activeAssignment(r.registration_id);
      if (!a) break;
      if (await serviceOf(a.task_id) === fx.services.ECG) ecg = a; else await completeCurrent(fx, r.registration_id);
    }
    expect(ecg).toBeDefined();
    await completeCurrent(fx, r.registration_id);
    const line = await must<{ id: string }>(db().from('order_items').select('id').eq('registration_id', r.registration_id).eq('test_id', fx.tests.ECG).single());
    const kinds = async () => (await must<{ kind: string }[]>(db().from('task_attendance_events').select('kind').eq('order_item_id', line.id))).map((x) => x.kind).sort();
    expect(await kinds()).toEqual(['appeared']);
    const other = Object.values(fx.stations).find((s) => s !== ecg!.station_id && s !== fx.stations['ECG-1'] && s !== fx.stations['ECG-2'] && s !== fx.stations['WI-1'])!;
    expect(await rpcError(fx.users.station_staff.client.rpc('confirm_order_item', { p_order_item: line.id, p_station: other }))).toMatch(/wrong_station|not_on_duty|invalid/);
    await must(fx.users.station_staff.client.rpc('confirm_order_item', { p_order_item: line.id, p_station: ecg!.station_id }));
    await must(fx.users.station_staff.client.rpc('confirm_order_item', { p_order_item: line.id, p_station: ecg!.station_id })); // retry: no-op
    expect(await kinds()).toEqual(['appeared', 'completed']);
  });
});

describe('station take-over and shift end', () => {
  it('a technician can serve a waiting participant who walked up to another compatible station', async () => {
    const r = await register(fx, 'male');
    let a = await activeAssignment(r.registration_id);
    while (a && await serviceOf(a.task_id) !== fx.services.SAMPLE) { await completeCurrent(fx, r.registration_id); a = await activeAssignment(r.registration_id); }
    expect(a).toBeDefined();
    const target = ['S-01', 'S-02', 'S-03'].map((c) => fx.stations[c]).find((s) => s !== a!.station_id)!;
    const staff = fx.users.station_staff.client;
    expect(await rpcError(staff.rpc('claim_task', { p_task: a!.task_id, p_station: fx.stations['ECG-1'] }))).toMatch(/incompatible_station/);
    await must(staff.rpc('claim_task', { p_task: a!.task_id, p_station: target }));
    const now = await activeAssignment(r.registration_id);
    expect(now.station_id).toBe(target);
    const old = await must<{ state: string }>(db().from('queue_assignments').select('state').eq('id', a!.id).single());
    expect(old.state).toBe('reassigned');
    await must(staff.rpc('task_action', { p_task: a!.task_id, p_action: 'start', p_station: target, p_reason: null }));
    expect(await rpcError(staff.rpc('claim_task', { p_task: a!.task_id, p_station: a!.station_id }))).toMatch(/illegal_transition/);
  });

  it('ending the last shift at a station moves its waiting participants elsewhere', async () => {
    const r = await register(fx, 'male');
    let a = await activeAssignment(r.registration_id);
    while (a && await serviceOf(a.task_id) !== fx.services.SAMPLE) { await completeCurrent(fx, r.registration_id); a = await activeAssignment(r.registration_id); }
    const shifts = await must<{ id: string }[]>(db().from('staff_assignments').select('id').eq('station_id', a!.station_id).eq('status', 'active'));
    for (const s of shifts) await must(fx.users.event_admin.client.rpc('end_staff_assignment', { p_assignment: s.id, p_reason: 'shift over' }));
    const now = await activeAssignment(r.registration_id);
    expect(now.station_id).not.toBe(a!.station_id);
    expect(now.task_id).toBe(a!.task_id);
  });
});
