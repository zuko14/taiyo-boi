import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildEvent, type Fixture } from '../../scripts/lib/fixture.ts';
import { activeAssignment, completeCurrent, db, must, newCode, register, rpcError, tasksOf } from './helpers.ts';

let fx: Fixture;
let priceId: string;
beforeAll(async () => {
  fx = await buildEvent({ code: newCode('PAY'), live: false });
  const admin = fx.users.event_admin.client;
  for (const t of ['XRAY', 'PSA']) await must(admin.from('test_catalog').update({ addon_available: true }).eq('id', fx.tests[t]));
  priceId = (await must<{ id: string }>(admin.from('addon_prices')
    .insert({ event_id: fx.eventId, test_id: fx.tests.XRAY, price_paise: 50000 }).select('id').single())).id;
  await must(admin.from('addon_prices').insert({ event_id: fx.eventId, test_id: fx.tests.PSA, price_paise: 40000 }));
  await must(admin.rpc('set_event_status', { p_event: fx.eventId, p_status: 'live' }));
});

const order = (regId: string, tests: string[]) => fx.users.addon_staff.client.rpc('create_addon_order', {
  p_reg: regId, p_desk: fx.stations['ADD-1'], p_test_ids: tests.map((t) => fx.tests[t]),
  p_idempotency_key: randomUUID(), p_consent: true });

describe('add-on orders', () => {
  it('rejects a test already in the participant\'s package', async () => {
    const r = await register(fx, 'male');
    expect(await rpcError(order(r.registration_id, ['XRAY']))).toMatch(/included_in_package/);
  });

  it('pending payment keeps the add-on task out of the queue; verification by a cashier releases it once', async () => {
    const r = await register(fx, 'female');
    const o = await must<{ order_id: string; intent_id: string; total_paise: number }>(order(r.registration_id, ['XRAY']));
    expect(o.total_paise).toBe(50000);
    const items = await must<{ responsibility: string; unit_price_paise: number }[]>(
      db().from('order_items').select('*').eq('order_id', o.order_id));
    expect(items).toEqual([expect.objectContaining({ responsibility: 'employee', unit_price_paise: 50000 })]);

    // complete all package tasks; the unpaid X-Ray must never be assigned
    for (let i = 0; i < 6; i++) if (!(await completeCurrent(fx, r.registration_id))) break;
    expect(await activeAssignment(r.registration_id)).toBeUndefined();
    const xray = (await tasksOf(r.registration_id)).find((t) => t.source === 'addon')!;
    expect(xray.status).toBe('not_ready');

    // the add-on desk cannot verify; maker-checker blocks the creator
    expect(await rpcError(fx.users.addon_staff.client.rpc('verify_payment', { p_intent: o.intent_id, p_method: 'upi_manual',
      p_provider_ref: 'UTR1', p_amount_paise: 50000 }))).toMatch(/permission_denied/);
    expect(await rpcError(fx.users.cashier.client.rpc('verify_payment', { p_intent: o.intent_id, p_method: 'card',
      p_provider_ref: 'X', p_amount_paise: 50000 }))).toMatch(/method_not_configured/);

    const ok = await must<{ status: string; receipt_no: string }>(fx.users.cashier.client.rpc('verify_payment',
      { p_intent: o.intent_id, p_method: 'upi_manual', p_provider_ref: `UTR-${o.intent_id}`, p_amount_paise: 50000 }));
    expect(ok.status).toBe('paid');
    expect(ok.receipt_no).toMatch(/^RCPT-/);
    const retry = await must<{ already: boolean }>(fx.users.cashier.client.rpc('verify_payment',
      { p_intent: o.intent_id, p_method: 'upi_manual', p_provider_ref: `UTR-${o.intent_id}`, p_amount_paise: 50000 }));
    expect(retry.already).toBe(true);
    const txns = await must<unknown[]>(db().from('payment_transactions').select('id').eq('intent_id', o.intent_id).eq('status', 'verified'));
    expect(txns).toHaveLength(1);
    expect((await activeAssignment(r.registration_id))?.task_id).toBe(xray.id);
  });

  it('duplicate references and amount mismatches go to review instead of being marked paid', async () => {
    const a = await register(fx, 'female');
    const b = await register(fx, 'female');
    const oa = await must<{ intent_id: string }>(order(a.registration_id, ['XRAY']));
    const ob = await must<{ intent_id: string }>(order(b.registration_id, ['XRAY']));
    await must(fx.users.cashier.client.rpc('verify_payment', { p_intent: oa.intent_id, p_method: 'upi_manual', p_provider_ref: 'SAME-REF', p_amount_paise: 50000 }));
    const dup = await must<{ status: string }>(fx.users.cashier.client.rpc('verify_payment',
      { p_intent: ob.intent_id, p_method: 'upi_manual', p_provider_ref: 'SAME-REF', p_amount_paise: 50000 }));
    expect(dup.status).toBe('requires_review');
    const c = await register(fx, 'female');
    const oc = await must<{ intent_id: string }>(order(c.registration_id, ['XRAY']));
    const mis = await must<{ status: string }>(fx.users.cashier.client.rpc('verify_payment',
      { p_intent: oc.intent_id, p_method: 'cash', p_provider_ref: null, p_amount_paise: 40000 }));
    expect(mis.status).toBe('requires_review');
  });

  it('a later price change does not alter an existing order (price snapshot)', async () => {
    const r = await register(fx, 'female');
    const o = await must<{ order_id: string }>(order(r.registration_id, ['XRAY']));
    const admin = fx.users.event_admin.client;
    const { error } = await admin.from('addon_prices').update({ price_paise: 99900 }).eq('id', priceId);
    expect(error?.message).toMatch(/reason_required/);    // live event
    await must(db().from('addon_prices').update({ price_paise: 99900 }).eq('id', priceId));
    const items = await must<{ unit_price_paise: number }[]>(db().from('order_items').select('unit_price_paise').eq('order_id', o.order_id));
    expect(items[0].unit_price_paise).toBe(50000);
  });

  it('full refund cancels unstarted add-on tasks; refunds need permission and a reason', async () => {
    const r = await register(fx, 'female');
    const o = await must<{ intent_id: string }>(order(r.registration_id, ['XRAY']));
    const intent = await must<{ amount_paise: number }>(db().from('payment_intents').select('amount_paise').eq('id', o.intent_id).single());
    await must(fx.users.cashier.client.rpc('verify_payment', { p_intent: o.intent_id, p_method: 'cash', p_provider_ref: null, p_amount_paise: intent.amount_paise }));
    expect(await rpcError(fx.users.cashier.client.rpc('payment_action', { p_intent: o.intent_id, p_action: 'refund',
      p_reason: 'changed mind', p_amount_paise: intent.amount_paise }))).toMatch(/permission_denied/);
    await must(fx.users.event_admin.client.rpc('payment_action', { p_intent: o.intent_id, p_action: 'refund',
      p_reason: 'participant changed mind', p_amount_paise: intent.amount_paise }));
    const t = (await tasksOf(r.registration_id)).find((x) => x.source === 'addon')!;
    expect(['cancelled', 'in_service', 'completed']).toContain(t.status);
    const rev = await must<{ totals: { refunded_paise: number } }>(fx.users.finance_viewer.client.rpc('addon_revenue', { p_event: fx.eventId }));
    expect(rev.totals.refunded_paise).toBeGreaterThan(0);
  });

  it('finance data is not visible to station staff', async () => {
    const { data } = await fx.users.station_staff.client.from('payment_intents').select('id');
    expect(data ?? []).toHaveLength(0);
    expect(await rpcError(fx.users.station_staff.client.rpc('addon_revenue', { p_event: fx.eventId }))).toMatch(/permission_denied/);
  });
});
