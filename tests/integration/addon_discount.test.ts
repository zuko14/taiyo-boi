import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildEvent, type Fixture } from '../../scripts/lib/fixture.ts';
import { db, must, newCode, register, rpcError, tasksOf } from './helpers.ts';

// BOI template: an eligible employee gets a % off one add-on test at the add-on desk; others pay the full price.
let fx: Fixture;
beforeAll(async () => {
  fx = await buildEvent({ code: newCode('ADISC'), live: false });
  const admin = fx.users.event_admin.client;
  for (const t of ['XRAY', 'PSA']) await must(admin.from('test_catalog').update({ addon_available: true }).eq('id', fx.tests[t]));
  await must(admin.from('addon_prices').insert({ event_id: fx.eventId, test_id: fx.tests.XRAY, price_paise: 50000 }));
  await must(admin.from('addon_prices').insert({ event_id: fx.eventId, test_id: fx.tests.PSA, price_paise: 40000 }));
  await must(admin.rpc('set_event_status', { p_event: fx.eventId, p_status: 'live' }));
});

const order = (regId: string, tests: string[], discounts: Record<string, number> | null, reason: string | null, who = fx.users.addon_staff.client) =>
  who.rpc('create_addon_order', {
    p_reg: regId, p_desk: fx.stations['ADD-1'], p_test_ids: tests.map((t) => fx.tests[t]), p_idempotency_key: randomUUID(), p_consent: true,
    p_discounts: discounts && Object.fromEntries(Object.entries(discounts).map(([k, v]) => [fx.tests[k], v])), p_discount_reason: reason });

describe('add-on desk discount', () => {
  it('add-on staff hold addon.discount by default', async () => {
    const ok = await must<boolean>(fx.users.addon_staff.client.rpc('has_perm', { p_event: fx.eventId, p_perm: 'addon.discount' }));
    expect(ok).toBe(true);
  });

  it('a reason is required and the % must be 0–100 on a selected test', async () => {
    const r = await register(fx, 'female');
    expect(await rpcError(order(r.registration_id, ['XRAY'], { XRAY: 20 }, null))).toMatch(/reason_required/);
    expect(await rpcError(order(r.registration_id, ['XRAY'], { XRAY: 120 }, 'x'))).toMatch(/invalid_amount/);
    expect(await rpcError(order(r.registration_id, ['XRAY'], { PSA: 10 }, 'x'))).toMatch(/invalid_amount/);
  });

  it('discounts only the eligible test; payment, order and audit follow the discounted price', async () => {
    const r = await register(fx, 'female');
    const o = await must<{ order_id: string; intent_id: string; total_paise: number }>(
      order(r.registration_id, ['XRAY', 'PSA'], { XRAY: 20 }, 'Senior employee (synthetic)'));
    expect(o.total_paise).toBe(40000 + 40000);                         // XRAY 500 → 400, PSA 400 unchanged
    const intent = await must<{ amount_paise: number; status: string }>(db().from('payment_intents').select('amount_paise, status').eq('id', o.intent_id).single());
    expect(intent).toEqual({ amount_paise: 80000, status: 'pending' });
    const items = await must<{ test_code: string; unit_price_paise: number; list_price_paise: number | null; discount_pct: number }[]>(
      db().from('order_items').select('test_code, unit_price_paise, list_price_paise, discount_pct').eq('order_id', o.order_id).order('test_code'));
    expect(items.map((i) => [i.unit_price_paise, i.list_price_paise, Number(i.discount_pct)])).toEqual([[40000, null, 0], [40000, 50000, 20]]);
    const ord = await must<{ list_total_paise: number; discount_reason: string; discounted_by: string }>(db().from('orders').select('list_total_paise, discount_reason, discounted_by').eq('id', o.order_id).single());
    expect(ord).toEqual({ list_total_paise: 90000, discount_reason: 'Senior employee (synthetic)', discounted_by: fx.users.addon_staff.id });
    // catalogue price unchanged for the next participant
    const r2 = await register(fx, 'female');
    expect((await must<{ total_paise: number }>(order(r2.registration_id, ['XRAY'], null, null))).total_paise).toBe(50000);
  });

  it('a 100% discount needs no payment and the test is queued like a free test', async () => {
    const r = await register(fx, 'female');
    const o = await must<{ order_id: string; intent_id: string | null; total_paise: number }>(order(r.registration_id, ['XRAY'], { XRAY: 100 }, 'Organiser waiver (synthetic)'));
    expect(o.total_paise).toBe(0);
    expect(await must<unknown[]>(db().from('payment_intents').select('id').eq('order_id', o.order_id))).toHaveLength(0);
    const xray = (await tasksOf(r.registration_id)).find((t) => t.source === 'addon')!;
    expect(xray.payment_intent_id).toBeNull();
  });

  it('staff without a discount permission are refused', async () => {
    await must(db().from('member_permission_overrides').insert({ event_id: fx.eventId, user_id: fx.users.addon_staff.id, permission_code: 'addon.discount', granted: false, created_by: fx.users.event_admin.id }));
    const r = await register(fx, 'female');
    expect(await rpcError(order(r.registration_id, ['XRAY'], { XRAY: 10 }, 'x'))).toMatch(/permission_denied/);
    expect((await must<{ total_paise: number }>(order(r.registration_id, ['XRAY'], null, null))).total_paise).toBe(50000);
  });
});
