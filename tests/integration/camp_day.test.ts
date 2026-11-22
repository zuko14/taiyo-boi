import { beforeAll, describe, expect, it } from 'vitest';
import { buildEvent, type Fixture } from '../../scripts/lib/fixture.ts';
import { activeAssignment, completeCurrent, db, must, newCode, register, rpcError, sha256 } from './helpers.ts';

let fx: Fixture;
beforeAll(async () => { fx = await buildEvent({ code: newCode('DAY') }); });

describe('registration code format', () => {
  it('a format without {CLS} shares one running number across packages and never reuses a code', async () => {
    const ev = await buildEvent({ code: newCode('FMT') });
    await must(db().from('events').update({ code_format: '{PREFIX}{SEQ}', code_prefix: 'VV', code_seq_digits: 3 }).eq('id', ev.eventId));
    const a = await register(ev, 'female');
    const b = await register(ev, 'male');
    expect([a.registration_code, b.registration_code]).toEqual(['VV001', 'VV002']);
    // switching back to a per-package format must not collide with codes already issued
    await must(db().from('events').update({ code_format: '{PREFIX}{CLS}{SEQ}' }).eq('id', ev.eventId));
    const c = await register(ev, 'female');
    expect(c.registration_code).toBe('VVF001');
    // a format without {SEQ} is rejected by the database
    expect(await rpcError(db().from('events').update({ code_format: '{PREFIX}' }).eq('id', ev.eventId))).toMatch(/code_format/);
  });
});

describe('priced tests are sellable', () => {
  it('saving an active price marks the test available to sell', async () => {
    const ecg = fx.tests['ECG'];
    await must(db().from('test_catalog').update({ addon_available: false }).eq('id', ecg));
    await must(db().from('addon_prices').insert({ event_id: fx.eventId, test_id: ecg, price_paise: 40000 }));
    const t = await must<{ addon_available: boolean }>(db().from('test_catalog').select('addon_available').eq('id', ecg).single());
    expect(t.addon_available).toBe(true);
  });
});

describe('staff on duty and portal next step', () => {
  it('shows the staff name at the assigned station, and the next station after completion', async () => {
    const r = await register(fx, 'male');
    const hash = sha256(`tok-${r.registration_id}`);
    await must(fx.users.registration_staff.client.rpc('issue_tag', { p_reg: r.registration_id, p_token_hash: hash, p_reason: null }));
    const duty = await must<{ station_id: string; staff: string }[]>(fx.users.registration_staff.client.rpc('station_on_duty', { p_event: fx.eventId }));
    const first = await activeAssignment(r.registration_id);
    expect(duty.find((d) => d.station_id === first.station_id)?.staff).toMatch(/station staff/);
    const v1 = await must<{ next_step: { station: string; staff: string } }>(db().rpc('portal_view', { p_token_hash: hash }));
    expect(v1.next_step.staff).toMatch(/station staff/);
    await completeCurrent(fx, r.registration_id);
    const next = await activeAssignment(r.registration_id);
    expect(next.task_id).not.toBe(first.task_id);
    // outsiders (anon) cannot list staff
    expect((await db().rpc('station_on_duty', { p_event: fx.eventId })).data ?? []).toEqual([]);
  });

  it('a waiting patient scanned at another compatible station can be taken over and started there', async () => {
    const r = await register(fx, 'female');
    let a = await activeAssignment(r.registration_id);
    // move them along until their current step is blood sample collection (3 compatible stations)
    for (let i = 0; i < 6 && !['S-01', 'S-02', 'S-03'].some((c) => fx.stations[c] === a.station_id); i++) {
      await completeCurrent(fx, r.registration_id); a = await activeAssignment(r.registration_id);
    }
    const other = ['S-01', 'S-02', 'S-03'].map((c) => fx.stations[c]).find((s) => s !== a.station_id)!;
    const staff = fx.users.station_staff.client;
    await must(staff.rpc('claim_task', { p_task: a.task_id, p_station: other }));
    await must(staff.rpc('task_action', { p_task: a.task_id, p_action: 'start', p_station: other, p_reason: null }));
    const now = await activeAssignment(r.registration_id);
    expect([now.station_id, now.state]).toEqual([other, 'in_service']);
  });
});

describe('online report window', () => {
  it('closes the portal reports after the configured days and sends patients to the walk-in centre', async () => {
    const r = await register(fx, 'female');
    const hash = sha256(`rep-${r.registration_id}`);
    await must(fx.users.registration_staff.client.rpc('issue_tag', { p_reg: r.registration_id, p_token_hash: hash, p_reason: null }));
    const ev = await must<{ settings: Record<string, unknown> }>(db().from('events').select('settings').eq('id', fx.eventId).single());

    // no limit by default
    await must(db().rpc('portal_otp_request', { p_token_hash: hash, p_code_hash: 'x' }).then((x) => x.error?.message.includes('no_mobile') ? { data: null, error: null } : x));
    // event ended 5 days ago, 3-day window: closed
    await must(db().from('events').update({ ends_at: new Date(Date.now() - 5 * 86400_000).toISOString(), settings: { ...ev.settings, report_access_days: 3 } }).eq('id', fx.eventId));
    const v = await must<{ event: { reports_closed: boolean }; report_centres: { name: string }[] }>(db().rpc('portal_view', { p_token_hash: hash }));
    expect(v.event.reports_closed).toBe(true);
    expect(v.report_centres.length).toBeGreaterThan(0);
    expect(await rpcError(db().rpc('portal_otp_request', { p_token_hash: hash, p_code_hash: 'x' }))).toMatch(/reports_closed/);
    expect(await rpcError(db().rpc('portal_reports', { p_token_hash: hash, p_session_hash: 'x' }))).toMatch(/verification_required|reports_closed/);
    // a 10-day window is still open
    await must(db().from('events').update({ settings: { ...ev.settings, report_access_days: 10 } }).eq('id', fx.eventId));
    const v2 = await must<{ event: { reports_closed: boolean } }>(db().rpc('portal_view', { p_token_hash: hash }));
    expect(v2.event.reports_closed).toBe(false);
    await must(db().from('events').update({ ends_at: null, settings: ev.settings }).eq('id', fx.eventId));
  });
});

describe('free tests (active ₹0 price)', () => {
  const price = async (ev: Fixture, code: string, paise: number) =>
    must(db().from('addon_prices').insert({ event_id: ev.eventId, test_id: ev.tests[code], price_paise: paise }));

  it('add-on desk: a free test creates no payment and is not held by a paid test bought with it', async () => {
    const ev = await buildEvent({ code: newCode('FREE') });
    await price(ev, 'XRAY', 0); await price(ev, 'PSA', 40000);
    const r = await register(ev, 'female');                    // XRAY and PSA are outside the female package
    const order = await must<{ intent_id: string | null }>(ev.users.addon_staff.client.rpc('create_addon_order', {
      p_reg: r.registration_id, p_desk: ev.stations['ADD-1'], p_test_ids: [ev.tests.XRAY, ev.tests.PSA], p_idempotency_key: `k-${r.registration_id}`, p_consent: true }));
    const intent = await must<{ amount_paise: number }>(db().from('payment_intents').select('amount_paise').eq('id', order.intent_id!).single());
    expect(intent.amount_paise).toBe(40000);                    // only the paid test
    const tasks = await must<{ service_name: string; payment_intent_id: string | null; source: string }[]>(
      db().from('participant_tasks').select('service_name, payment_intent_id, source').eq('registration_id', r.registration_id).eq('source', 'addon'));
    expect(tasks.find((t) => /x-?ray/i.test(t.service_name))?.payment_intent_id).toBeNull();
    const freeOnly = await register(ev, 'female');
    const o2 = await must<{ intent_id: string | null }>(ev.users.addon_staff.client.rpc('create_addon_order', {
      p_reg: freeOnly.registration_id, p_desk: ev.stations['ADD-1'], p_test_ids: [ev.tests.XRAY], p_idempotency_key: `k-${freeOnly.registration_id}`, p_consent: true }));
    expect(o2.intent_id ?? null).toBeNull();
  });

  it('registration desk (pay-per-test camp): free tests only → registered with no payment and queued', async () => {
    const ev = await buildEvent({ code: newCode('FREG') });
    const { data: e } = await db().from('events').select('settings').eq('id', ev.eventId).single();
    await must(db().from('events').update({ settings: { ...e!.settings, package_mode: 'custom', payment_model: 'patient_pays', payment_methods: ['cash'] } }).eq('id', ev.eventId));
    await price(ev, 'ECG', 0);
    const r = await must<{ registration_id: string; tests_intent_id: string | null; payment_intent_id: string | null }>(ev.users.registration_staff.client.rpc('register_participant', {
      p_counter: ev.stations['REG-1'], p_idempotency_key: `free-${ev.eventId}`, p_classification: '', p_full_name: 'Synthetic Free', p_consent: true, p_test_ids: [ev.tests.ECG] }));
    expect([r.tests_intent_id ?? null, r.payment_intent_id ?? null]).toEqual([null, null]);
    expect(await must<unknown[]>(db().from('payment_intents').select('id').eq('registration_id', r.registration_id))).toHaveLength(0);
    const a = await activeAssignment(r.registration_id);
    expect(a?.station_id).toBe(ev.stations['ECG-1'] === a?.station_id ? ev.stations['ECG-1'] : ev.stations['ECG-2']);
  });
});

describe('discounts', () => {
  it('bulk discount: applied to every priced test, free stays free, 0% restores, orders keep their price', async () => {
    const ev = await buildEvent({ code: newCode('DISC') });
    const admin = ev.users.event_admin.client;
    await must(db().from('addon_prices').insert([
      { event_id: ev.eventId, test_id: ev.tests.XRAY, price_paise: 99999 },
      { event_id: ev.eventId, test_id: ev.tests.PSA, price_paise: 40000 },
      { event_id: ev.eventId, test_id: ev.tests.ECG, price_paise: 0 }]));
    const cur = async (code: string) => must<{ price_paise: number; mrp_paise: number | null; discount_pct: number }>(
      db().from('addon_prices').select('price_paise, mrp_paise, discount_pct').eq('test_id', ev.tests[code]).eq('active', true).single());

    // an order placed before the discount keeps its price
    const before = await register(ev, 'female');
    await must(ev.users.addon_staff.client.rpc('create_addon_order', { p_reg: before.registration_id, p_desk: ev.stations['ADD-1'],
      p_test_ids: [ev.tests.PSA], p_idempotency_key: `b-${before.registration_id}`, p_consent: true }));

    expect(await must(admin.rpc('apply_discount', { p_event: ev.eventId, p_discount_pct: 12.5 }))).toMatchObject({ tests: 2 });
    expect(await cur('XRAY')).toMatchObject({ price_paise: 87499, mrp_paise: 99999 });
    expect(await cur('PSA')).toMatchObject({ price_paise: 35000, mrp_paise: 40000 });
    expect((await cur('ECG')).price_paise).toBe(0);
    // a second discount is taken off the original price, never stacked
    await must(admin.rpc('apply_discount', { p_event: ev.eventId, p_discount_pct: 20 }));
    expect(await cur('PSA')).toMatchObject({ price_paise: 32000, mrp_paise: 40000 });

    const after = await register(ev, 'female');
    const o = await must<{ intent_id: string }>(ev.users.addon_staff.client.rpc('create_addon_order', { p_reg: after.registration_id, p_desk: ev.stations['ADD-1'],
      p_test_ids: [ev.tests.PSA], p_idempotency_key: `a-${after.registration_id}`, p_consent: true }));
    expect((await must<{ amount_paise: number }>(db().from('payment_intents').select('amount_paise').eq('id', o.intent_id).single())).amount_paise).toBe(32000);
    const old = await must<{ amount_paise: number }[]>(db().from('payment_intents').select('amount_paise').eq('registration_id', before.registration_id));
    expect(old.map((x) => x.amount_paise)).toEqual([40000]);

    await must(admin.rpc('apply_discount', { p_event: ev.eventId, p_discount_pct: 0 }));
    expect(await cur('PSA')).toMatchObject({ price_paise: 40000, mrp_paise: null });
    // the database refuses a price that does not match its discount
    expect(await rpcError(db().from('addon_prices').insert({ event_id: ev.eventId, test_id: ev.tests.TFT, price_paise: 100, mrp_paise: 1000, discount_pct: 10 }))).toMatch(/discount_math/);
    // only price editors may discount
    expect(await rpcError(ev.users.registration_staff.client.rpc('apply_discount', { p_event: ev.eventId, p_discount_pct: 50 }))).toMatch(/permission_denied/);
  });

  it('package discount: participant is charged the discounted package price', async () => {
    const ev = await buildEvent({ code: newCode('PDIS') });
    const { data: e } = await db().from('events').select('settings').eq('id', ev.eventId).single();
    await must(db().from('events').update({ settings: { ...e!.settings, package_mode: 'custom', payment_model: 'patient_pays', payment_methods: ['cash'] } }).eq('id', ev.eventId));
    await must(ev.users.event_admin.client.rpc('set_package_rate', { p_package: ev.packages.female, p_amount_paise: 200000, p_discount_pct: 25, p_reason: 'Camp offer' }));
    const pk = await must<{ price_paise: number; mrp_paise: number; discount_pct: number }>(db().from('packages').select('price_paise, mrp_paise, discount_pct').eq('id', ev.packages.female).single());
    expect(pk).toMatchObject({ price_paise: 150000, mrp_paise: 200000 });
    const r = await register(ev, 'female');
    const pay = await must<{ amount_paise: number }[]>(db().from('payment_intents').select('amount_paise').eq('registration_id', r.registration_id));
    expect(pay.map((x) => x.amount_paise)).toEqual([150000]);
    await must(ev.users.event_admin.client.rpc('apply_discount', { p_event: ev.eventId, p_discount_pct: 10, p_include_packages: true }));
    expect((await must<{ price_paise: number }>(db().from('packages').select('price_paise').eq('id', ev.packages.female).single())).price_paise).toBe(180000);
  });
});

describe('per-patient discount at the registration desk', () => {
  let ev: Fixture;
  const reg = (extra: Record<string, unknown>) => ev.users.registration_staff.client.rpc('register_participant', {
    p_counter: ev.stations['REG-1'], p_idempotency_key: `d-${Math.random()}`, p_full_name: 'Synthetic Desk', p_consent: true, ...extra });
  beforeAll(async () => {
    ev = await buildEvent({ code: newCode('DDSK') });
    const { data: e } = await db().from('events').select('settings').eq('id', ev.eventId).single();
    await must(db().from('events').update({ settings: { ...e!.settings, package_mode: 'custom', payment_model: 'patient_pays', payment_methods: ['cash'] } }).eq('id', ev.eventId));
    await must(db().from('addon_prices').insert([{ event_id: ev.eventId, test_id: ev.tests.PSA, price_paise: 40000 }, { event_id: ev.eventId, test_id: ev.tests.XRAY, price_paise: 50000 }]));
    await must(ev.users.event_admin.client.rpc('set_package_rate', { p_package: ev.packages.male, p_amount_paise: 200000, p_reason: 'set price' }));
  });

  it('discounts only this patient, is charged, and is tracked with who and why', async () => {
    const r = await must<{ registration_id: string; tests_intent_id: string }>(reg({ p_classification: '', p_test_ids: [ev.tests.PSA, ev.tests.XRAY],
      p_discounts: { [ev.tests.PSA]: 25 }, p_discount_reason: 'Senior citizen' }));
    const intent = await must<{ amount_paise: number }>(db().from('payment_intents').select('amount_paise').eq('id', r.tests_intent_id).single());
    expect(intent.amount_paise).toBe(30000 + 50000);
    const items = await must<{ test_code: string; unit_price_paise: number; list_price_paise: number | null; discount_pct: number }[]>(
      db().from('order_items').select('test_code, unit_price_paise, list_price_paise, discount_pct').eq('registration_id', r.registration_id).order('test_code'));
    expect(items.map((i) => [i.test_code, i.unit_price_paise, i.list_price_paise, Number(i.discount_pct)])).toEqual([['PSA', 30000, 40000, 25], ['XRAY', 50000, null, 0]]);
    const order = await must<{ discount_reason: string; discounted_by: string; list_total_paise: number }>(db().from('orders').select('discount_reason, discounted_by, list_total_paise').eq('registration_id', r.registration_id).eq('kind', 'addon').single());
    expect(order).toMatchObject({ discount_reason: 'Senior citizen', discounted_by: ev.users.registration_staff.id, list_total_paise: 90000 });
    // the catalogue price and the next patient are unaffected
    const next = await must<{ tests_intent_id: string }>(reg({ p_classification: '', p_test_ids: [ev.tests.PSA] }));
    expect((await must<{ amount_paise: number }>(db().from('payment_intents').select('amount_paise').eq('id', next.tests_intent_id).single())).amount_paise).toBe(40000);
  });

  it('package discount: 25% charged at 75%; 100% leaves no payment but keeps the record', async () => {
    const a = await must<{ registration_id: string; payment_intent_id: string }>(reg({ p_classification: 'male', p_package_discount_pct: 25, p_discount_reason: 'Organiser family' }));
    expect((await must<{ amount_paise: number }>(db().from('payment_intents').select('amount_paise').eq('id', a.payment_intent_id).single())).amount_paise).toBe(150000);
    const b = await must<{ registration_id: string; payment_intent_id: string | null }>(reg({ p_classification: 'male', p_package_discount_pct: 100, p_discount_reason: 'Sponsored by organiser' }));
    expect(b.payment_intent_id ?? null).toBeNull();
    const o = await must<{ total_paise: number; list_total_paise: number; discount_pct: number }>(db().from('orders').select('total_paise, list_total_paise, discount_pct').eq('registration_id', b.registration_id).not('discount_reason', 'is', null).single());
    expect([o.total_paise, o.list_total_paise, Number(o.discount_pct)]).toEqual([0, 200000, 100]);
  });

  it('needs a reason, a valid %, a selected test, and the registration.discount permission', async () => {
    expect(await rpcError(reg({ p_classification: '', p_test_ids: [ev.tests.PSA], p_discounts: { [ev.tests.PSA]: 10 } }))).toMatch(/reason_required/);
    expect(await rpcError(reg({ p_classification: '', p_test_ids: [ev.tests.PSA], p_discounts: { [ev.tests.PSA]: 120 }, p_discount_reason: 'x' }))).toMatch(/invalid_amount/);
    expect(await rpcError(reg({ p_classification: '', p_test_ids: [ev.tests.PSA], p_discounts: { [ev.tests.XRAY]: 10 }, p_discount_reason: 'x' }))).toMatch(/invalid_amount/);
    expect(await rpcError(reg({ p_classification: 'female', p_package_discount_pct: 10, p_discount_reason: 'x' }))).toMatch(/no price to discount/);
    await must(db().from('role_permissions').delete().eq('event_id', ev.eventId).eq('permission_code', 'registration.discount'));
    expect(await rpcError(reg({ p_classification: '', p_test_ids: [ev.tests.PSA], p_discounts: { [ev.tests.PSA]: 10 }, p_discount_reason: 'x' }))).toMatch(/permission_denied/);
    // without a discount, registration still works for staff without the permission
    await must(reg({ p_classification: '', p_test_ids: [ev.tests.PSA] }));
  });
});
