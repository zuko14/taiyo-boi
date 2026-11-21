import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildEvent, type Fixture } from '../../scripts/lib/fixture.ts';
import { completeCurrent, db, must, newCode, register, rpcError, sha256 } from './helpers.ts';

let fx: Fixture;
beforeAll(async () => { fx = await buildEvent({ code: newCode('LIFE') }); });

const count = async (table: string) => (await db().from(table).select('*', { count: 'exact', head: true }).eq('event_id', fx.eventId)).count ?? 0;

describe('pilot reset', () => {
  it('only event.reset holders can reset, and the code must match', async () => {
    expect(await rpcError(fx.users.registration_staff.client.rpc('reset_event', { p_event: fx.eventId, p_confirm_code: fx.eventCode, p_reason: 'x' }))).toMatch(/permission_denied/);
    expect(await rpcError(fx.users.event_admin.client.rpc('reset_event', { p_event: fx.eventId, p_confirm_code: 'WRONG', p_reason: 'x' }))).toMatch(/confirm_mismatch/);
  });

  it('removes all operational data, keeps configuration, restarts codes', async () => {
    const r = await register(fx, 'female');
    await completeCurrent(fx, r.registration_id);
    const item = (await must<{ id: string }[]>(db().from('order_items').select('id').eq('registration_id', r.registration_id).limit(1)))[0];
    await must(fx.users.report_manager.client.rpc('report_create', { p_order_item: item.id, p_title: 'R', p_file_name: 'r.pdf',
      p_mime: 'application/pdf', p_size: 10, p_checksum: sha256(randomUUID()), p_accession: null }));
    expect(await count('task_attendance_events')).toBeGreaterThan(0);
    const testsBefore = await count('test_catalog');

    const keys = await must<string[]>(fx.users.event_admin.client.rpc('reset_event', { p_event: fx.eventId, p_confirm_code: fx.eventCode.toLowerCase(), p_reason: 'pilot done' }));
    expect(keys).toHaveLength(1);
    for (const t of ['registrations', 'participants', 'order_items', 'participant_tasks', 'queue_assignments', 'task_attendance_events',
      'task_status_history', 'reports', 'scan_events', 'staff_assignments']) expect(await count(t), t).toBe(0);
    expect(await count('test_catalog')).toBe(testsBefore);
    expect(await count('packages')).toBe(2);
    const ev = await must<{ status: string }>(db().from('events').select('status').eq('id', fx.eventId).single());
    expect(ev.status).toBe('draft');
    const st = await must<{ status: string }[]>(db().from('stations').select('status').eq('event_id', fx.eventId));
    expect(st.every((s) => s.status === 'closed')).toBe(true);
    const audit = await must<unknown[]>(db().from('audit_logs').select('id').eq('event_id', fx.eventId).eq('action', 'event.reset'));
    expect(audit).toHaveLength(1);

    // back to live: codes restart at 000001
    const a = fx.users.event_admin.client;
    const start = new Date(Date.now() - 60_000).toISOString(); const end = new Date(Date.now() + 3600_000).toISOString();
    await must(a.rpc('assign_staff', { p_station: fx.stations['REG-1'], p_user: fx.users.registration_staff.id, p_start: start, p_end: end }));
    await must(a.rpc('station_set_status', { p_station: fx.stations['REG-1'], p_status: 'open', p_reason: null }));
    // reset cleared every shift: going live is refused until diagnostic stations are staffed again
    expect(await rpcError(a.rpc('set_event_status', { p_event: fx.eventId, p_status: 'live', p_reason: null }))).toMatch(/no diagnostic station is open with staff on shift/);
    for (const code of ['S-01', 'ECG-1', 'BMD-1', 'BC-1', 'XR-1', 'WI-1'])
      await must(a.rpc('assign_staff', { p_station: fx.stations[code], p_user: code === 'WI-1' ? fx.users.walkin_staff.id : fx.users.station_staff.id, p_start: start, p_end: end }));
    const opened = await must<{ status: string }[]>(db().from('stations').select('status').eq('event_id', fx.eventId).in('code', ['S-01', 'ECG-1', 'BMD-1']));
    expect(opened.every((x) => x.status === 'open')).toBe(true);           // reopened automatically with their first shift
    await must(a.rpc('set_event_status', { p_event: fx.eventId, p_status: 'live', p_reason: null }));
    const again = await register(fx, 'female');
    expect(again.registration_code).toMatch(/-000001$/);
  });
});

describe('catalogue and custom packages', () => {
  it('a test used in orders cannot be deleted; an unused one is removed from packages and prices', async () => {
    expect(await rpcError(fx.users.event_admin.client.rpc('delete_test', { p_test: fx.tests.CBC, p_reason: 'x' }))).toMatch(/in_use/);
    // unused test on a draft (custom) event: removed together with its package line and price
    const a = fx.platform.client;
    const ev = await must<string>(a.rpc('create_event', { p_code: newCode('DEL'), p_name: 'Delete test camp' }));
    const t = await must<{ id: string }>(a.from('test_catalog').insert({ event_id: ev, code: 'TMPDEL', display_name: 'Temp', location: 'event_day' }).select('id').single());
    const pkg = await must<string>(a.rpc('create_package', { p_event: ev, p_code: 'P1', p_name: 'P1', p_code_letter: 'P' }));
    await must(a.from('package_tests').insert({ event_id: ev, package_id: pkg, test_id: t.id }));
    await must(a.from('addon_prices').insert({ event_id: ev, test_id: t.id, price_paise: 5000 }));
    await must(a.rpc('delete_test', { p_test: t.id, p_reason: 'cleanup' }));
    expect(await must<unknown[]>(db().from('test_catalog').select('id').eq('id', t.id))).toHaveLength(0);
    expect(await must<unknown[]>(db().from('package_tests').select('id').eq('package_id', pkg))).toHaveLength(0);
  });

  it('female/male events reject extra packages and hide rates', async () => {
    expect(await rpcError(fx.users.event_admin.client.rpc('create_package', { p_event: fx.eventId, p_code: 'X', p_name: 'X', p_code_letter: 'X' }))).toMatch(/package_mode/);
    expect(await must<unknown[]>(fx.users.event_admin.client.rpc('package_rates', { p_event: fx.eventId }))).toHaveLength(0);
  });

  it('custom event: create packages with tests and price, register, delete', async () => {
    const a = fx.platform.client;
    const ev = await must<string>(a.rpc('create_event', { p_code: newCode('CUST'), p_name: 'Apartment camp' }));
    const mode = await must<string>(a.rpc('package_mode', { p_event: ev }));
    expect(mode).toBe('custom');
    const pkg = await must<string>(a.rpc('create_package', { p_event: ev, p_code: 'basic', p_name: 'Basic Check', p_code_letter: 'b' }));
    expect(await rpcError(a.rpc('create_package', { p_event: ev, p_code: 'OTHER', p_name: 'Other', p_code_letter: 'B' }))).toMatch(/duplicate|unique/i);
    await must(a.rpc('set_package_rate', { p_package: pkg, p_amount_paise: 99900 }));
    const rates = await must<{ package_id: string; amount_paise: number }[]>(a.rpc('package_rates', { p_event: ev }));
    expect(rates).toEqual([{ package_id: pkg, amount_paise: 99900 }]);
    const validation = await must<{ level: string; message: string }[]>(a.rpc('validate_event', { p_event: ev }));
    expect(validation.some((v) => /Missing (female|male)/.test(v.message))).toBe(false);
    expect(validation.some((v) => v.message === 'Package "Basic Check" has no tests')).toBe(true);
    await must(a.rpc('delete_package', { p_package: pkg, p_reason: 'test' }));
    expect(await must<unknown[]>(db().from('packages').select('id').eq('event_id', ev))).toHaveLength(0);
    await must(a.rpc('delete_event', { p_event: ev, p_confirm_code: (await must<{ code: string }>(db().from('events').select('code').eq('id', ev).single())).code }));
  });
});

describe('owner delete', () => {
  it('cannot go live with no open, staffed diagnostic station', async () => {
    const a = fx.platform.client;
    const ev = await must<string>(a.rpc('create_event', { p_code: newCode('NOST'), p_name: 'No staff camp' }));
    const svc = await must<{ id: string }>(a.from('workflow_services').insert({ event_id: ev, code: 'BLOOD', name: 'Blood', location: 'event_day' }).select('id').single());
    const t = await must<{ id: string }>(a.from('test_catalog').insert({ event_id: ev, code: 'CBC', display_name: 'CBC', location: 'event_day' }).select('id').single());
    await must(a.from('workflow_service_tests').insert({ event_id: ev, service_id: svc.id, test_id: t.id }));
    const pkg = await must<string>(a.rpc('create_package', { p_event: ev, p_code: 'B', p_name: 'B', p_code_letter: 'B' }));
    await must(a.from('package_tests').insert({ event_id: ev, package_id: pkg, test_id: t.id }));
    await must(a.from('stations').insert({ event_id: ev, code: 'R1', name: 'Reg', kind: 'registration_counter' }));
    const st = await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'S1', name: 'S1', kind: 'station' }).select('id').single());
    await must(a.from('station_capabilities').insert({ event_id: ev, station_id: st.id, service_id: svc.id }));
    expect(await rpcError(a.rpc('set_event_status', { p_event: ev, p_status: 'live', p_reason: null }))).toMatch(/no diagnostic station is open with staff on shift/);
    const cov = await must<{ service_name: string; station_status: string; staff_now: number }[]>(a.rpc('service_coverage', { p_event: ev }));
    expect(cov).toEqual([expect.objectContaining({ service_name: 'Blood', station_status: 'closed', staff_now: 0 })]);
    await must(a.from('event_memberships').insert({ event_id: ev, user_id: fx.users.station_staff.id, role_code: 'station_staff', created_by: fx.platform.id }));
    await must(a.rpc('assign_staff', { p_station: st.id, p_user: fx.users.station_staff.id, p_start: new Date(Date.now() - 60_000).toISOString(), p_end: new Date(Date.now() + 3600_000).toISOString() }));
    await must(a.rpc('set_event_status', { p_event: ev, p_status: 'live', p_reason: null }));   // station opened with its first shift
    // a station a supervisor closed is never reopened by assigning another shift
    await must(a.rpc('station_set_status', { p_station: st.id, p_status: 'closed', p_reason: 'broken' }));
    await must(a.rpc('assign_staff', { p_station: st.id, p_user: fx.users.station_staff.id, p_start: new Date(Date.now() - 60_000).toISOString(), p_end: new Date(Date.now() + 7200_000).toISOString() }));
    expect((await must<{ status: string }>(db().from('stations').select('status').eq('id', st.id).single())).status).toBe('closed');
  });

  it('only platform admins can delete, never while live, and everything goes', async () => {
    expect(await rpcError(fx.users.event_admin.client.rpc('delete_event', { p_event: fx.eventId, p_confirm_code: fx.eventCode }))).toMatch(/permission_denied/);
    expect(await rpcError(fx.platform.client.rpc('delete_event', { p_event: fx.eventId, p_confirm_code: fx.eventCode }))).toMatch(/event_live/);
    await must(fx.platform.client.rpc('set_event_status', { p_event: fx.eventId, p_status: 'closed', p_reason: 'done' }));
    await must(fx.platform.client.rpc('delete_event', { p_event: fx.eventId, p_confirm_code: fx.eventCode }));
    expect(await must<unknown[]>(db().from('events').select('id').eq('id', fx.eventId))).toHaveLength(0);
    for (const t of ['test_catalog', 'packages', 'stations', 'registrations', 'audit_logs', 'event_memberships']) expect(await count(t), t).toBe(0);
    const log = await must<{ meta: { code: string } }[]>(db().from('audit_logs').select('meta').is('event_id', null).eq('action', 'event.delete').eq('entity_id', fx.eventId));
    expect(log[0].meta.code).toBe(fx.eventCode);
  });
});

describe('custom event registration', () => {
  it('registers on an admin-created package with its own code letter and tasks', async () => {
    const a = fx.platform.client;
    const ev = await must<string>(a.rpc('create_event', { p_code: newCode('APT'), p_name: 'Apartment camp' }));
    const svc = await must<{ id: string }>(a.from('workflow_services').insert({ event_id: ev, code: 'BLOOD', name: 'Blood draw', location: 'event_day' }).select('id').single());
    const t = await must<{ id: string }>(a.from('test_catalog').insert({ event_id: ev, code: 'CBC', display_name: 'CBC', location: 'event_day' }).select('id').single());
    await must(a.from('workflow_service_tests').insert({ event_id: ev, service_id: svc.id, test_id: t.id }));
    const pkg = await must<string>(a.rpc('create_package', { p_event: ev, p_code: 'BASIC', p_name: 'Basic', p_code_letter: 'B' }));
    await must(a.from('package_tests').insert({ event_id: ev, package_id: pkg, test_id: t.id }));
    const reg = await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'R1', name: 'Reg', kind: 'registration_counter' }).select('id').single());
    const st = await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'B1', name: 'Blood 1', kind: 'station' }).select('id').single());
    await must(a.from('station_capabilities').insert({ event_id: ev, station_id: st.id, service_id: svc.id }));
    await must(a.from('event_memberships').insert({ event_id: ev, user_id: fx.users.registration_staff.id, role_code: 'registration_staff', created_by: fx.platform.id }));
    const start = new Date(Date.now() - 60_000).toISOString(); const end = new Date(Date.now() + 3600_000).toISOString();
    await must(a.rpc('assign_staff', { p_station: reg.id, p_user: fx.users.registration_staff.id, p_start: start, p_end: end }));
    await must(a.from('event_memberships').insert({ event_id: ev, user_id: fx.users.station_staff.id, role_code: 'station_staff', created_by: fx.platform.id }));
    await must(a.rpc('assign_staff', { p_station: st.id, p_user: fx.users.station_staff.id, p_start: start, p_end: end }));
    for (const s of [reg.id, st.id]) await must(a.rpc('station_set_status', { p_station: s, p_status: 'open', p_reason: null }));
    await must(a.rpc('set_event_status', { p_event: ev, p_status: 'live', p_reason: null }));
    const r = await must<{ registration_id: string; registration_code: string }>(fx.users.registration_staff.client.rpc('register_participant', {
      p_counter: reg.id, p_idempotency_key: randomUUID(), p_classification: 'basic', p_full_name: 'Synthetic Resident', p_consent: true }));
    expect(r.registration_code).toMatch(/^APT-B-\d{4}-000001$/);      // new camps use their own event code as prefix
    const tasks = await must<{ station_id: string | null }[]>(db().from('participant_tasks').select('station_id').eq('registration_id', r.registration_id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].station_id).toBe(st.id);
    expect(await rpcError(fx.users.registration_staff.client.rpc('register_participant', {
      p_counter: reg.id, p_idempotency_key: randomUUID(), p_classification: 'female', p_full_name: 'X', p_consent: true }))).toMatch(/invalid_classification/);
    expect(await rpcError(a.rpc('delete_package', { p_package: pkg, p_reason: 'x' }))).toMatch(/in_use/);
  });
});
