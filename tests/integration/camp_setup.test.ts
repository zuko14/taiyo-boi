import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildEvent, type Fixture } from '../../scripts/lib/fixture.ts';
import { db, must, newCode, rpcError } from './helpers.ts';

// A brand-new apartment camp set up from nothing, the way an admin does it in the screens.
let fx: Fixture; let ev: string;
const svcId = (code: string) => must<{ id: string }>(db().from('workflow_services').select('id').eq('event_id', ev).eq('code', code).single()).then((r) => r.id);
const testId = (code: string) => must<{ id: string }>(db().from('test_catalog').select('id').eq('event_id', ev).eq('code', code).single()).then((r) => r.id);

beforeAll(async () => {
  fx = await buildEvent({ code: newCode('SETUP') });
  ev = await must<string>(fx.platform.client.rpc('create_event', { p_code: newCode('VV'), p_name: 'Vasanth Vihar camp' }));
  await must(fx.platform.client.from('events').update({ settings: { require_consent: true, payment_maker_checker: true, report_maker_checker: true,
    payment_methods: ['cash'], portal_otp_required: true, default_service_minutes: 5, package_mode: 'custom' } }).eq('id', ev));
  for (const [role, u] of [['registration_staff', fx.users.registration_staff], ['station_staff', fx.users.station_staff], ['cashier', fx.users.cashier]] as const)
    await must(fx.platform.client.from('event_memberships').insert({ event_id: ev, user_id: u.id, role_code: role, created_by: fx.platform.id }));
});

describe('visits (what a station does)', () => {
  it('any blood/sample name is the shared SAMPLE visit; others get their own', async () => {
    const a = fx.platform.client;
    const blood = await must<string>(a.rpc('ensure_service', { p_event: ev, p_name: 'Blood sample collection', p_location: 'event_day' }));
    expect(await must<string>(a.rpc('ensure_service', { p_event: ev, p_name: 'sample collection', p_location: 'event_day' }))).toBe(blood);
    expect(blood).toBe(await svcId('SAMPLE'));
    const xray = await must<string>(a.rpc('ensure_service', { p_event: ev, p_name: 'X-Ray', p_location: 'event_day' }));
    expect(xray).toBe(await svcId('X-RAY'));
    expect(await rpcError(a.rpc('ensure_service', { p_event: ev, p_name: 'X-Ray', p_location: 'walk_in' }))).toMatch(/already exists/);
    expect(await rpcError(fx.users.registration_staff.client.rpc('ensure_service', { p_event: ev, p_name: 'ECG', p_location: 'event_day' }))).toMatch(/permission_denied/);
  });
});

describe('stations', () => {
  it('a station that never served anyone can be deleted; one with history cannot', async () => {
    const a = fx.platform.client;
    const spare = await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'SPARE', name: 'Spare', kind: 'station' }).select('id').single());
    await must(a.from('station_capabilities').insert({ event_id: ev, station_id: spare.id, service_id: await svcId('SAMPLE') }));
    await must(a.rpc('assign_staff', { p_station: spare.id, p_user: fx.users.station_staff.id, p_start: new Date().toISOString(), p_end: new Date(Date.now() + 3600_000).toISOString() }));
    await must(a.rpc('delete_station', { p_station: spare.id, p_reason: 'not needed' }));
    expect(await must<unknown[]>(db().from('stations').select('id').eq('id', spare.id))).toHaveLength(0);
    expect(await rpcError(fx.users.station_staff.client.rpc('delete_station', { p_station: spare.id }))).toMatch(/not_found|permission_denied/);
  });
});

describe('fresh paid camp, end to end', () => {
  let reg: string; let blood: string; let xray: string;
  beforeAll(async () => {
    const a = fx.platform.client;
    await must(a.rpc('import_catalog', { p_event: ev, p_rows: [
      { code: 'CBC', name: 'CBC', category: 'Haematology', price_paise: 25000, location: 'event_day', service_code: null, lab_order_code: '', instructions: '' },
      { code: 'HBA1C', name: 'HbA1c', category: 'Diabetes', price_paise: 50000, location: 'event_day', service_code: null, lab_order_code: '', instructions: '' },
      { code: 'XRAY-CHEST', name: 'X-Ray Chest', category: 'Radiology', price_paise: 60000, location: 'event_day', service_code: 'X-RAY', lab_order_code: '', instructions: '' },
    ] }));
    reg = (await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'R1', name: 'Registration', kind: 'registration_counter' }).select('id').single())).id;
    blood = (await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'B1', name: 'Blood collection', kind: 'station' }).select('id').single())).id;
    xray = (await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'X01', name: 'x-Ray', kind: 'station' }).select('id').single())).id;
    await must(a.from('station_capabilities').insert({ event_id: ev, station_id: blood, service_id: await svcId('SAMPLE') }));
    await must(a.from('station_capabilities').insert({ event_id: ev, station_id: xray, service_id: await svcId('X-RAY') }));
    const start = new Date(Date.now() - 60_000).toISOString(); const end = new Date(Date.now() + 3600_000).toISOString();
    await must(a.rpc('assign_staff', { p_station: reg, p_user: fx.users.registration_staff.id, p_start: start, p_end: end }));
    await must(a.rpc('station_set_status', { p_station: reg, p_status: 'open', p_reason: null }));
    for (const s of [blood, xray]) await must(a.rpc('assign_staff', { p_station: s, p_user: fx.users.station_staff.id, p_start: start, p_end: end }));
    const errors = (await must<{ level: string; message: string }[]>(a.rpc('validate_event', { p_event: ev }))).filter((c) => c.level === 'error');
    expect(errors).toEqual([]);
    await must(a.rpc('set_event_status', { p_event: ev, p_status: 'live', p_reason: null }));
  });

  it('spot registration → pay → blood station → X-Ray station → done, with no manual queue steps', async () => {
    const r = await must<{ registration_id: string; tests_intent_id: string }>(fx.users.registration_staff.client.rpc('register_participant', {
      p_counter: reg, p_idempotency_key: randomUUID(), p_classification: '', p_full_name: 'Synthetic Resident', p_consent: true,
      p_test_ids: [await testId('CBC'), await testId('HBA1C'), await testId('XRAY-CHEST')] }));
    const tasks = await must<{ service_name: string; status: string }[]>(db().from('participant_tasks').select('service_name, status').eq('registration_id', r.registration_id).order('service_name'));
    expect(tasks.map((t) => t.service_name)).toEqual(['Blood sample collection', 'X-Ray']);    // CBC + HbA1c share the one blood visit
    expect(tasks.every((t) => t.status === 'not_ready')).toBe(true);                         // unpaid
    await must(fx.users.cashier.client.rpc('verify_payment', { p_intent: r.tests_intent_id, p_method: 'cash', p_provider_ref: null, p_amount_paise: 135000 }));

    const staff = fx.users.station_staff.client;
    for (let visit = 0; visit < 2; visit++) {
      const q = (await must<{ task_id: string; station_id: string; state: string }[]>(db().from('queue_assignments').select('task_id, station_id, state')
        .eq('registration_id', r.registration_id).in('state', ['queued', 'called', 'in_service'])))[0];
      expect(q.state).toBe('called');                                                         // called automatically
      expect([blood, xray]).toContain(q.station_id);
      await must(staff.rpc('task_action', { p_task: q.task_id, p_action: 'start', p_station: q.station_id, p_reason: null }));
      await must(staff.rpc('task_action', { p_task: q.task_id, p_action: 'complete', p_station: q.station_id, p_reason: null }));
    }
    const done = await must<{ status: string }[]>(db().from('participant_tasks').select('status').eq('registration_id', r.registration_id));
    expect(done.every((t) => t.status === 'completed')).toBe(true);
    const attended = await must<{ kind: string }[]>(db().from('task_attendance_events').select('kind').eq('registration_id', r.registration_id).eq('kind', 'completed'));
    expect(attended).toHaveLength(3);                                                        // every test line evidenced

    // a station that has served a patient keeps its history
    expect(await rpcError(fx.platform.client.rpc('delete_station', { p_station: blood, p_reason: 'x' }))).toMatch(/in_use/);
  });

  it('revenue insights list the payment with patient name and what was paid for', async () => {
    await must(db().from('event_memberships').insert({ event_id: ev, user_id: fx.users.finance_viewer.id, role_code: 'finance_viewer', created_by: fx.platform.id }));
    const ins = await must<{ recent: { name: string; what: string; amount_paise: number; method: string; receipt: string }[] }>(
      fx.users.finance_viewer.client.rpc('revenue_insights', { p_event: ev }));
    expect(ins.recent[0]).toMatchObject({ name: 'Synthetic Resident', what: 'CBC, HbA1c, X-Ray Chest', amount_paise: 135000, method: 'cash' });
    expect(ins.recent[0].receipt).toMatch(/^RCPT-/);
  });

  it('a sponsored camp never charges at registration, even if a package has a price', async () => {
    // live-event config is set up with the system account (no change reason needed for fixtures)
    const pkg = (await must<{ id: string }>(db().from('packages').insert({ event_id: ev, classification: 'corp', code: 'CORP', name: 'Corporate', code_letter: 'C', price_paise: 99900 }).select('id').single())).id;
    await must(db().from('package_tests').insert({ event_id: ev, package_id: pkg, test_id: await testId('CBC') }));
    const { data: e } = await db().from('events').select('settings').eq('id', ev).single();
    await must(db().from('events').update({ settings: { ...(e!.settings as object), payment_model: 'sponsored' } }).eq('id', ev));
    expect(await rpcError(fx.users.registration_staff.client.rpc('register_participant', { p_counter: reg, p_idempotency_key: randomUUID(),
      p_classification: '', p_full_name: 'X', p_consent: true, p_test_ids: [await testId('CBC')] }))).toMatch(/sponsored/);
    const r = await must<{ registration_id: string; payment_intent_id: string | null }>(fx.users.registration_staff.client.rpc('register_participant', {
      p_counter: reg, p_idempotency_key: randomUUID(), p_classification: 'corp', p_full_name: 'Synthetic Employee', p_consent: true }));
    expect(r.payment_intent_id).toBeNull();
    expect(await must<unknown[]>(db().from('payment_intents').select('id').eq('registration_id', r.registration_id))).toHaveLength(0);
    const q = (await must<{ state: string }[]>(db().from('queue_assignments').select('state').eq('registration_id', r.registration_id)))[0];
    expect(q.state).toBe('called');                                                           // free → straight to the blood station
  });
});
