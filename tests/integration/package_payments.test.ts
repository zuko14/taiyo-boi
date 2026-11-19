import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildEvent, type Fixture } from '../../scripts/lib/fixture.ts';
import { db, must, newCode, rpcError } from './helpers.ts';

// A custom (non-BOI) camp: one paid package (CBC via a blood station), staffed and live.
let fx: Fixture; let ev: string; let reg: string; let pkg: string;
beforeAll(async () => {
  fx = await buildEvent({ code: newCode('PPAY') });   // supplies synthetic staff accounts
  const a = fx.platform.client;
  ev = await must<string>(a.rpc('create_event', { p_code: newCode('APTP'), p_name: 'Apartment paid camp' }));
  await must(a.from('events').update({ settings: { require_consent: true, payment_maker_checker: true, report_maker_checker: true,
    payment_methods: ['cash', 'upi_manual'], portal_otp_required: true, default_service_minutes: 5, package_mode: 'custom', upi_vpa: 'lab@okicici' } }).eq('id', ev));
  const svc = await must<{ id: string }>(a.from('workflow_services').insert({ event_id: ev, code: 'BLOOD', name: 'Blood draw', location: 'event_day' }).select('id').single());
  const t = await must<{ id: string }>(a.from('test_catalog').insert({ event_id: ev, code: 'CBC', display_name: 'CBC', location: 'event_day' }).select('id').single());
  await must(a.from('workflow_service_tests').insert({ event_id: ev, service_id: svc.id, test_id: t.id }));
  pkg = await must<string>(a.rpc('create_package', { p_event: ev, p_code: 'BASIC', p_name: 'Basic', p_code_letter: 'B' }));
  await must(a.from('package_tests').insert({ event_id: ev, package_id: pkg, test_id: t.id }));
  await must(a.rpc('set_package_rate', { p_package: pkg, p_amount_paise: 49900 }));
  reg = (await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'R1', name: 'Reg', kind: 'registration_counter' }).select('id').single())).id;
  const st = await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'B1', name: 'Blood 1', kind: 'station' }).select('id').single());
  await must(a.from('station_capabilities').insert({ event_id: ev, station_id: st.id, service_id: svc.id }));
  for (const [role, u] of [['registration_staff', fx.users.registration_staff], ['station_staff', fx.users.station_staff], ['cashier', fx.users.cashier], ['finance_viewer', fx.users.finance_viewer]] as const)
    await must(a.from('event_memberships').insert({ event_id: ev, user_id: u.id, role_code: role, created_by: fx.platform.id }));
  const start = new Date(Date.now() - 60_000).toISOString(); const end = new Date(Date.now() + 3600_000).toISOString();
  await must(a.rpc('assign_staff', { p_station: reg, p_user: fx.users.registration_staff.id, p_start: start, p_end: end }));
  await must(a.rpc('assign_staff', { p_station: st.id, p_user: fx.users.station_staff.id, p_start: start, p_end: end }));
  for (const s of [reg, st.id]) await must(a.rpc('station_set_status', { p_station: s, p_status: 'open', p_reason: null }));
  await must(a.rpc('set_event_status', { p_event: ev, p_status: 'live', p_reason: null }));
});

const registerOne = () => must<{ registration_id: string; payment_intent_id: string | null }>(fx.users.registration_staff.client.rpc('register_participant', {
  p_counter: reg, p_idempotency_key: randomUUID(), p_classification: 'basic', p_full_name: 'Synthetic Resident', p_consent: true }));
const tasks = (r: string) => must<{ status: string; station_id: string | null; payment_intent_id: string | null }[]>(db().from('participant_tasks').select('status, station_id, payment_intent_id').eq('registration_id', r));

describe('participant-paid package', () => {
  it('registration creates one payment for the package price and holds tasks until verified', async () => {
    const r = await registerOne();
    expect(r.payment_intent_id).toBeTruthy();
    const intent = await must<{ amount_paise: number; status: string }>(db().from('payment_intents').select('amount_paise, status').eq('id', r.payment_intent_id!).single());
    expect(intent).toEqual({ amount_paise: 49900, status: 'pending' });
    const before = await tasks(r.registration_id);
    expect(before.every((t) => t.payment_intent_id === r.payment_intent_id && t.station_id === null)).toBe(true);

    // a package payment cannot be cancelled like an add-on
    expect(await rpcError(fx.platform.client.rpc('payment_action', { p_intent: r.payment_intent_id, p_action: 'cancel', p_reason: 'x' }))).toMatch(/package payment cannot be cancelled/);

    const res = await must<{ ok: boolean; receipt_no: string }>(fx.users.cashier.client.rpc('verify_payment',
      { p_intent: r.payment_intent_id, p_method: 'upi_manual', p_provider_ref: `UTR${randomUUID().slice(0, 8)}`, p_amount_paise: 49900 }));
    expect(res.ok).toBe(true);
    const after = await tasks(r.registration_id);
    expect(after[0].status).toBe('called');            // station free: called automatically, no 'Call next'
    const rc = await must<{ snapshot: { package: { name: string; amount_paise: number } } }>(db().from('receipts').select('snapshot').eq('receipt_no', res.receipt_no).single());
    expect(rc.snapshot.package).toEqual({ name: 'Basic', amount_paise: 49900 });
  });

  it('a later price change never alters an existing registration', async () => {
    const r = await registerOne();
    await must(fx.platform.client.rpc('set_package_rate', { p_package: pkg, p_amount_paise: 59900, p_reason: 'price update' }));
    const i = await must<{ amount_paise: number }>(db().from('payment_intents').select('amount_paise').eq('id', r.payment_intent_id!).single());
    expect(i.amount_paise).toBe(49900);
    const r2 = await registerOne();
    const i2 = await must<{ amount_paise: number }>(db().from('payment_intents').select('amount_paise').eq('id', r2.payment_intent_id!).single());
    expect(i2.amount_paise).toBe(59900);
    await must(fx.platform.client.rpc('set_package_rate', { p_package: pkg, p_amount_paise: 49900, p_reason: 'restore' }));
  });

  it('revenue insights count verified money only; add-on revenue excludes package payments', async () => {
    const ins = await must<{ totals: { collected_paise: number; paying_participants: number }; open: { pending_paise: number };
      by_source: { source: string; collected_paise: number }[]; by_method: { method: string }[]; timeline: unknown[]; top_items: { kind: string; name: string }[] }>(
      fx.users.finance_viewer.client.rpc('revenue_insights', { p_event: ev }));
    expect(ins.totals.collected_paise).toBe(49900);
    expect(ins.totals.paying_participants).toBe(1);
    expect(ins.open.pending_paise).toBe(49900 + 59900);
    expect(ins.by_source.find((s) => s.source === 'package')?.collected_paise).toBe(49900);
    expect(ins.by_method.map((m) => m.method)).toEqual(['upi_manual']);
    expect(ins.timeline).toHaveLength(1);
    expect(ins.top_items[0]).toMatchObject({ kind: 'package', name: 'Basic' });
    const addon = await must<{ totals: { verified_received_paise: number; pending_paise: number } }>(fx.users.finance_viewer.client.rpc('addon_revenue', { p_event: ev }));
    expect(addon.totals).toMatchObject({ verified_received_paise: 0, pending_paise: 0 });
    expect(await rpcError(fx.users.registration_staff.client.rpc('revenue_insights', { p_event: ev }))).toMatch(/permission_denied/);
  });

  it('fixed Female/Male packages can never carry a participant price', async () => {
    expect(await rpcError(fx.platform.client.rpc('set_package_rate', { p_package: fx.packages.female, p_amount_paise: 100 }))).toMatch(/package_mode/);
    expect(await rpcError(db().from('packages').update({ price_paise: 100 }).eq('id', fx.packages.female))).toMatch(/package_mode/);
  });
});
