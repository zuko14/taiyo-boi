import { beforeAll, describe, expect, it } from 'vitest';
import { buildEvent, type Fixture } from '../../scripts/lib/fixture.ts';
import { db, must, newCode, rpcError } from './helpers.ts';

let fx: Fixture; let ev: string;
beforeAll(async () => {
  fx = await buildEvent({ code: newCode('PKGB'), live: false });
  const a = fx.platform.client;
  ev = await must<string>(a.rpc('create_event', { p_code: newCode('PB'), p_name: 'Package builder camp' }));
  await must(a.from('event_memberships').insert({ event_id: ev, user_id: fx.users.event_admin.id, role_code: 'event_admin', created_by: fx.platform.id }));
  await must(a.rpc('import_catalog', { p_event: ev, p_rows: ['CBC', 'LFT', 'LIPID', 'HBA1C', 'TSH'].map((code) => (
    { code, name: code, category: 'Blood', price_paise: 30000, location: 'event_day', service_code: null, lab_order_code: '', instructions: '' })) }));
});
const ids = async (codes: string[]) => (await must<{ id: string; code: string }[]>(db().from('test_catalog').select('id, code').eq('event_id', ev).in('code', codes))).map((t) => t.id);
const content = async (pkg: string) => (await must<{ test_catalog: { code: string } }[]>(db().from('package_tests').select('test_catalog(code)').eq('package_id', pkg)))
  .map((r) => r.test_catalog.code).sort();

describe('package builder', () => {
  it('an event admin sets many tests at once and edits the list', async () => {
    const admin = fx.users.event_admin.client;
    const pkg = await must<string>(admin.rpc('create_package', { p_event: ev, p_code: 'BASIC', p_name: 'Basic check', p_code_letter: 'B', p_description: '' }));
    await must(admin.from('package_tests').insert((await ids(['CBC', 'LFT', 'LIPID', 'HBA1C'])).map((test_id) => ({ event_id: ev, package_id: pkg, test_id }))));
    expect(await content(pkg)).toEqual(['CBC', 'HBA1C', 'LFT', 'LIPID']);
    const lft = (await ids(['LFT']))[0];
    await must(admin.from('package_tests').delete().eq('package_id', pkg).eq('test_id', lft));
    await must(admin.from('package_tests').insert({ event_id: ev, package_id: pkg, test_id: (await ids(['TSH']))[0] }));
    expect(await content(pkg)).toEqual(['CBC', 'HBA1C', 'LIPID', 'TSH']);
  });

  it('the automatic Pay per test package can never get tests or a price', async () => {
    const pp = (await must<{ id: string }>(db().from('packages').insert({ event_id: ev, classification: 'pay_per_test', code: 'PAY_PER_TEST', name: 'Pay per test', code_letter: 'T' }).select('id').single())).id;
    expect(await rpcError(fx.users.event_admin.client.from('package_tests').insert({ event_id: ev, package_id: pp, test_id: (await ids(['CBC']))[0] })))
      .toMatch(/no tests of its own/);
    expect(await rpcError(fx.users.event_admin.client.rpc('set_package_rate', { p_package: pp, p_amount_paise: 10000, p_reason: null }))).toMatch(/always free/);
    expect(await content(pp)).toEqual([]);
  });
});
