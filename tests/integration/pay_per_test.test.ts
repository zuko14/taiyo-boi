import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildEvent, type Fixture } from '../../scripts/lib/fixture.ts';
import { db, must, newCode, register, rpcError } from './helpers.ts';

// A custom (non-BOI) apartment camp, built through the CSV import RPC.
let fx: Fixture; let ev: string; let reg: string; let station: string;
const T = (code: string) => must<{ id: string }>(db().from('test_catalog').select('id').eq('event_id', ev).eq('code', code).single()).then((r) => r.id);
beforeAll(async () => {
  fx = await buildEvent({ code: newCode('PPT') });
  const a = fx.platform.client;
  ev = await must<string>(a.rpc('create_event', { p_code: newCode('APT3'), p_name: 'Apartment pay-per-test camp' }));
  await must(a.from('events').update({ settings: { require_consent: true, payment_maker_checker: true, report_maker_checker: true,
    payment_methods: ['cash', 'upi_manual'], portal_otp_required: true, default_service_minutes: 5, package_mode: 'custom' } }).eq('id', ev));
  reg = (await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'R1', name: 'Reg', kind: 'registration_counter' }).select('id').single())).id;
  for (const [role, u] of [['registration_staff', fx.users.registration_staff], ['station_staff', fx.users.station_staff], ['cashier', fx.users.cashier]] as const)
    await must(a.from('event_memberships').insert({ event_id: ev, user_id: u.id, role_code: role, created_by: fx.platform.id }));
});

describe('catalogue import', () => {
  it('creates tests, default service and prices; re-import updates without duplicating', async () => {
    const rows = [
      { code: 'CBC', name: 'CBC', category: 'Haematology', price_paise: 35000, location: 'event_day', service_code: null, lab_order_code: '', instructions: '' },
      { code: 'TSH', name: 'TSH', category: 'Thyroid', price_paise: 30000, location: 'event_day', service_code: null, lab_order_code: '', instructions: '' },
      { code: 'USG-ABD', name: 'USG Abdomen', category: 'Radiology', price_paise: 150000, location: 'walk_in', service_code: 'USG', lab_order_code: '', instructions: '' },
    ];
    expect(await must(fx.platform.client.rpc('import_catalog', { p_event: ev, p_rows: rows }))).toMatchObject({ created: 3, updated: 0, prices_changed: 3 });
    const svcs = await must<{ code: string; location: string }[]>(db().from('workflow_services').select('code, location').eq('event_id', ev).order('code'));
    expect(svcs).toEqual([{ code: 'SAMPLE', location: 'event_day' }, { code: 'USG', location: 'walk_in' }]);
    const again = await must(fx.platform.client.rpc('import_catalog', { p_event: ev, p_rows: [{ ...rows[0], price_paise: 40000 }, rows[1]] }));
    expect(again).toMatchObject({ created: 0, updated: 0, prices_changed: 1 });
    const prices = await must<{ price_paise: number; active: boolean }[]>(db().from('addon_prices').select('price_paise, active').eq('test_id', await T('CBC')).order('created_at'));
    expect(prices).toEqual([{ price_paise: 35000, active: false }, { price_paise: 40000, active: true }]);
    expect(await rpcError(fx.platform.client.rpc('import_catalog', { p_event: ev, p_rows: [{ ...rows[0], location: 'walk_in', service_code: 'SAMPLE' }] }))).toMatch(/invalid_import: row 1 \(CBC\) is walk_in, but service SAMPLE is event_day/);
    expect(await rpcError(fx.users.registration_staff.client.rpc('import_catalog', { p_event: ev, p_rows: rows }))).toMatch(/permission_denied/);
  });
});

describe('pay-per-test registration', () => {
  beforeAll(async () => {
    const a = fx.platform.client;
    station = (await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'B1', name: 'Blood 1', kind: 'station' }).select('id').single())).id;
    const sample = (await must<{ id: string }>(db().from('workflow_services').select('id').eq('event_id', ev).eq('code', 'SAMPLE').single())).id;
    await must(a.from('station_capabilities').insert({ event_id: ev, station_id: station, service_id: sample }));
    const start = new Date(Date.now() - 60_000).toISOString(); const end = new Date(Date.now() + 3600_000).toISOString();
    await must(a.rpc('assign_staff', { p_station: reg, p_user: fx.users.registration_staff.id, p_start: start, p_end: end }));
    await must(a.rpc('assign_staff', { p_station: station, p_user: fx.users.station_staff.id, p_start: start, p_end: end }));
    await must(a.rpc('station_set_status', { p_station: reg, p_status: 'open', p_reason: null }));
    const centre = (await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'WI1', name: 'Centre', kind: 'walkin_centre' }).select('id').single())).id;
    const walk = await must<{ id: string }[]>(db().from('workflow_services').select('id').eq('event_id', ev).eq('location', 'walk_in'));
    for (const w of walk) await must(a.from('station_capabilities').insert({ event_id: ev, station_id: centre, service_id: w.id }));
    const check = await must<{ level: string; message: string }[]>(a.rpc('validate_event', { p_event: ev }));
    expect(check.filter((c) => c.level === 'error')).toEqual([]);   // no packages needed: priced tests suffice
    // a never-opened station opens with its first shift; going live needs one open staffed station
    expect((await must<{ status: string }>(db().from('stations').select('status').eq('id', station).single())).status).toBe('open');
    await must(a.rpc('set_event_status', { p_event: ev, p_status: 'live', p_reason: null }));
    // then the blood station closes: patients must wait, and be picked up automatically when it reopens
    await must(a.rpc('station_set_status', { p_station: station, p_status: 'closed', p_reason: 'equipment check' }));
  });

  const regTests = async (ids: string[], classification = '') => must<{ registration_id: string; registration_code: string; tests_intent_id: string | null }>(
    fx.users.registration_staff.client.rpc('register_participant', { p_counter: reg, p_idempotency_key: randomUUID(),
      p_classification: classification, p_full_name: 'Synthetic Resident', p_consent: true, p_test_ids: ids }));

  it('tests only: one payment for the chosen tests, queued only after it is verified', async () => {
    const r = await regTests([await T('CBC'), await T('TSH')]);
    const intent = await must<{ amount_paise: number }>(db().from('payment_intents').select('amount_paise').eq('id', r.tests_intent_id!).single());
    expect(intent.amount_paise).toBe(40000 + 30000);
    const pkg = await must<{ packages: { code: string } }>(db().from('registrations').select('packages(code)').eq('id', r.registration_id).single());
    expect(pkg.packages.code).toBe('PAY_PER_TEST');
    let tasks = await must<{ status: string }[]>(db().from('participant_tasks').select('status').eq('registration_id', r.registration_id));
    expect(tasks).toEqual([{ status: 'not_ready' }]);               // one sample visit for both tests, unpaid
    await must(fx.users.cashier.client.rpc('verify_payment', { p_intent: r.tests_intent_id, p_method: 'cash', p_provider_ref: null, p_amount_paise: 70000 }));
    tasks = await must(db().from('participant_tasks').select('status').eq('registration_id', r.registration_id));
    expect(tasks).toEqual([{ status: 'waiting_unassigned' }]);      // paid, but no open station yet

    // station opened outside the RPC (as when a shift's start time simply arrives): nothing fires...
    await must(db().from('stations').update({ status: 'open' }).eq('id', station));
    expect((await must<{ status: string }[]>(db().from('participant_tasks').select('status').eq('registration_id', r.registration_id)))[0].status).toBe('waiting_unassigned');
    // ...until any staff screen refreshes and nudges the queue
    expect(await must<number>(fx.users.station_staff.client.rpc('nudge_waiting', { p_event: ev }))).toBe(1);
    expect((await must<{ status: string; station_id: string }[]>(db().from('participant_tasks').select('status, station_id').eq('registration_id', r.registration_id)))[0])
      .toEqual({ status: 'called', station_id: station });   // free station: called automatically
    expect(await must<number>(fx.users.station_staff.client.rpc('nudge_waiting', { p_event: ev }))).toBe(0);
  });

  it('a failed test selection rolls the whole registration back', async () => {
    const before = (await db().from('registrations').select('*', { count: 'exact', head: true }).eq('event_id', ev)).count;
    expect(await rpcError(fx.users.registration_staff.client.rpc('register_participant', { p_counter: reg, p_idempotency_key: randomUUID(),
      p_classification: '', p_full_name: 'X', p_consent: true, p_test_ids: [randomUUID()] }))).toMatch(/invalid_test/);
    expect(await rpcError(fx.users.registration_staff.client.rpc('register_participant', { p_counter: reg, p_idempotency_key: randomUUID(),
      p_classification: '', p_full_name: 'X', p_consent: true, p_test_ids: null }))).toMatch(/choose a package or at least one test/);
    expect((await db().from('registrations').select('*', { count: 'exact', head: true }).eq('event_id', ev)).count).toBe(before);
  });

  it('the Bank of India event still sells extra tests only at the add-on desk', async () => {
    expect(await rpcError(fx.users.registration_staff.client.rpc('register_participant', { p_counter: fx.stations['REG-1'], p_idempotency_key: randomUUID(),
      p_classification: 'female', p_full_name: 'X', p_consent: true, p_test_ids: [fx.tests.PSA] }))).toMatch(/package_mode/);
    expect((await register(fx, 'female')).registration_code).toMatch(/^BOI-F-/);
  });
});
