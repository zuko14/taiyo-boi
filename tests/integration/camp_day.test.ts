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
