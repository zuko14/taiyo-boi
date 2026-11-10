import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildEvent, type Fixture } from '../../scripts/lib/fixture.ts';
import { db, must, newCode, register, rpcError, tasksOf } from './helpers.ts';

let fx: Fixture;
beforeAll(async () => { fx = await buildEvent({ code: newCode('REG') }); });

async function itemsOf(regId: string) {
  return must<{ test_code: string; location: string; source: string; responsibility: string; unit_price_paise: number }[]>(
    db().from('order_items').select('*').eq('registration_id', regId).eq('status', 'active'));
}

describe('package generation', () => {
  it('female package: 14 event-day lines + walk-in USG choice group awaiting selection', async () => {
    const r = await register(fx, 'female');
    expect(r.registration_code).toMatch(/^BOI-F-\d{4}-\d{6}$/);
    const items = await itemsOf(r.registration_id);
    expect(items.map((i) => i.test_code).sort()).toEqual(
      ['B2-BT2', 'BMD', 'BODYCOMP', 'CA-125', 'CALCIUM', 'CBC', 'D', 'ECG', 'HBA1C', 'LFT', 'LIPID', 'T3', 'T4', 'TSH']);
    expect(items.every((i) => i.location === 'event_day' && i.responsibility === 'sponsor' && i.unit_price_paise === 0)).toBe(true);
    const tasks = await tasksOf(r.registration_id);
    const usg = tasks.filter((t) => t.location === 'walk_in');
    expect(usg).toHaveLength(1);
    expect(usg[0].status).toBe('awaiting_choice');
    // grouped encounter: 14 lines -> 4 queue stops (sample, ECG, BMD, body comp), not 14
    expect(tasks.filter((t) => t.location === 'event_day')).toHaveLength(4);
  });

  it('male package: 13 event-day lines + walk-in USG Thyroid task', async () => {
    const r = await register(fx, 'male');
    expect(r.registration_code).toMatch(/^BOI-M-\d{4}-\d{6}$/);
    const items = await itemsOf(r.registration_id);
    expect(items.filter((i) => i.location === 'event_day').map((i) => i.test_code).sort()).toEqual(
      ['B2-BT2', 'BMD', 'BODYCOMP', 'CALCIUM', 'CBC', 'D', 'ECG', 'HBA1C', 'LFT', 'LIPID', 'PSA', 'TFT', 'XRAY']);
    expect(items.filter((i) => i.location === 'walk_in').map((i) => i.test_code)).toEqual(['USG-THYROID']);
    const tasks = await tasksOf(r.registration_id);
    expect(tasks.find((t) => t.location === 'walk_in')?.status).toBe('not_attended');
  });

  it('sponsored packages never create employee payments', async () => {
    const r = await register(fx, 'female');
    const intents = await must<unknown[]>(db().from('payment_intents').select('id').eq('registration_id', r.registration_id));
    expect(intents).toHaveLength(0);
  });
});

describe('codes, idempotency, concurrency', () => {
  it('a retried request with the same idempotency key returns the same registration', async () => {
    const key = randomUUID();
    const args = { p_counter: fx.stations['REG-1'], p_idempotency_key: key, p_classification: 'male',
      p_full_name: 'Retry Person', p_consent: true };
    const a = await must<{ registration_id: string }>(fx.users.registration_staff.client.rpc('register_participant', args));
    const b = await must<{ registration_id: string; already: boolean }>(fx.users.registration_staff.client.rpc('register_participant', args));
    expect(b.registration_id).toBe(a.registration_id);
    expect(b.already).toBe(true);
  });

  it('parallel counters never issue duplicate codes', async () => {
    const staff = [fx.users.registration_staff.client, fx.users.registration_supervisor.client];
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      must<{ registration_code: string }>(staff[i % 2].rpc('register_participant', {
        p_counter: fx.stations[i % 2 ? 'REG-2' : 'REG-1'], p_idempotency_key: randomUUID(),
        p_classification: i % 3 ? 'female' : 'male', p_full_name: `Parallel ${i}`, p_consent: true }))));
    const codes = results.map((r) => r.registration_code);
    expect(new Set(codes).size).toBe(40);
    const all = await must<{ registration_code: string }[]>(db().from('registrations').select('registration_code').eq('event_id', fx.eventId));
    expect(new Set(all.map((r) => r.registration_code)).size).toBe(all.length);
  });

  it('consent is required', async () => {
    const msg = await rpcError(fx.users.registration_staff.client.rpc('register_participant', {
      p_counter: fx.stations['REG-1'], p_idempotency_key: randomUUID(), p_classification: 'female',
      p_full_name: 'No Consent', p_consent: false }));
    expect(msg).toMatch(/consent_required/);
  });
});

describe('classification and permissions', () => {
  it('registration staff cannot override the package mapping; a supervisor can, with a reason', async () => {
    const args = { p_counter: fx.stations['REG-1'], p_idempotency_key: randomUUID(), p_classification: 'female',
      p_full_name: 'Override', p_consent: true, p_package_override: fx.packages.male, p_override_reason: 'Approved by lab' };
    expect(await rpcError(fx.users.registration_staff.client.rpc('register_participant', args))).toMatch(/permission_denied/);
    const ok = await must<{ registration_code: string }>(fx.users.registration_supervisor.client.rpc('register_participant',
      { ...args, p_idempotency_key: randomUUID() }));
    expect(ok.registration_code).toMatch(/^BOI-M-/);
  });

  it('staff without a shift at the counter cannot register', async () => {
    const msg = await rpcError(fx.users.addon_staff.client.rpc('register_participant', {
      p_counter: fx.stations['REG-1'], p_idempotency_key: randomUUID(), p_classification: 'female',
      p_full_name: 'X', p_consent: true }));
    expect(msg).toMatch(/not_on_duty|permission_denied/);
  });

  it('anonymous clients cannot call RPCs or read tables', async () => {
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const { error } = await anon.rpc('register_participant', { p_counter: fx.stations['REG-1'], p_idempotency_key: 'x',
      p_classification: 'female', p_full_name: 'x' });
    expect(error).not.toBeNull();
    const { data, error: e2 } = await anon.from('registrations').select('id');
    expect(e2 !== null || (data ?? []).length === 0).toBe(true);
  });

  it('sponsor backend rates are not readable by any staff role, even the event admin', async () => {
    const { data, error } = await fx.users.event_admin.client.from('sponsor_backend_rates').select('*');
    expect(error !== null || (data ?? []).length === 0).toBe(true);
    const svc = await must<{ amount_paise: number }[]>(db().from('sponsor_backend_rates').select('amount_paise').eq('event_id', fx.eventId));
    expect(svc.map((r) => r.amount_paise).sort()).toEqual([199900, 299900]);
  });

  it('cannot create a third package category', async () => {
    const { error } = await db().from('packages').insert({ event_id: fx.eventId, classification: 'female',
      code: 'X', name: 'Third', code_letter: 'X' });
    expect(error).not.toBeNull();
  });
});

describe('configuration snapshots', () => {
  it('editing a live package needs a reason and only affects new registrations', async () => {
    const before = await register(fx, 'female');
    const admin = fx.users.event_admin.client;
    // live event: plain edit is refused
    const { error } = await admin.from('package_tests').delete().eq('package_id', fx.packages.female).eq('test_id', fx.tests['D']);
    expect(error?.message).toMatch(/reason_required/);

    const session = (await admin.auth.getSession()).data.session!;
    const withReason = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: `Bearer ${session.access_token}`,
        'x-audit-reason': Buffer.from('Lab Partner removed D (test)').toString('base64') } },
      auth: { persistSession: false } });
    await must(withReason.from('package_tests').delete().eq('package_id', fx.packages.female).eq('test_id', fx.tests['D']));

    const after = await register(fx, 'female');
    const codes = async (id: string) => (await itemsOf(id)).map((i) => i.test_code);
    expect(await codes(before.registration_id)).toContain('D');
    expect(await codes(after.registration_id)).not.toContain('D');
    const audit = await must<{ reason: string }[]>(db().from('audit_logs').select('reason')
      .eq('event_id', fx.eventId).eq('entity_type', 'package_tests').eq('action', 'delete'));
    expect(audit.some((a) => a.reason === 'Lab Partner removed D (test)')).toBe(true);
  });
});
