import { beforeAll, describe, expect, it } from 'vitest';
import { buildEvent, type Fixture } from '../../scripts/lib/fixture.ts';
import { activeAssignment, completeCurrent, db, must, newCode, register, rpcError } from './helpers.ts';

// Mock drill: clear patients only; staff, shifts, stations and status stay so the next drill starts at once.
let fx: Fixture;
beforeAll(async () => { fx = await buildEvent({ code: newCode('DRILL') }); });

const count = async (table: string) => (await db().from(table).select('*', { count: 'exact', head: true }).eq('event_id', fx.eventId)).count ?? 0;
const admin = () => fx.users.event_admin.client;

describe('reset operations only (training drills)', () => {
  it('needs event.reset, the event code, a reason, and a paused event', async () => {
    expect(await rpcError(fx.users.registration_staff.client.rpc('reset_operations', { p_event: fx.eventId, p_confirm_code: fx.eventCode, p_reason: 'x' }))).toMatch(/permission_denied/);
    expect(await rpcError(admin().rpc('reset_operations', { p_event: fx.eventId, p_confirm_code: fx.eventCode, p_reason: 'x' }))).toMatch(/event_live/);
    await must(admin().rpc('set_event_status', { p_event: fx.eventId, p_status: 'paused', p_reason: 'drill over' }));
    expect(await rpcError(admin().rpc('reset_operations', { p_event: fx.eventId, p_confirm_code: 'WRONG', p_reason: 'x' }))).toMatch(/confirm_mismatch/);
    expect(await rpcError(admin().rpc('reset_operations', { p_event: fx.eventId, p_confirm_code: fx.eventCode, p_reason: ' ' }))).toMatch(/reason_required/);
    await must(admin().rpc('set_event_status', { p_event: fx.eventId, p_status: 'live', p_reason: 'resume' }));
  });

  it('removes patients and keeps staff shifts, open stations and status; the next drill works straight away', async () => {
    const r1 = await register(fx, 'female');
    await completeCurrent(fx, r1.registration_id);
    await register(fx, 'male');
    const shifts = await count('staff_assignments');
    const members = await count('event_memberships');
    const stationsBefore = await must<{ id: string; status: string }[]>(db().from('stations').select('id, status').eq('event_id', fx.eventId).order('id'));
    expect(shifts).toBeGreaterThan(0);

    await must(admin().rpc('set_event_status', { p_event: fx.eventId, p_status: 'paused', p_reason: 'drill 1 over' }));
    await must(admin().rpc('reset_operations', { p_event: fx.eventId, p_confirm_code: fx.eventCode.toLowerCase(), p_reason: 'Drill 1 finished (synthetic)' }));

    for (const t of ['registrations', 'participants', 'orders', 'order_items', 'participant_tasks', 'queue_assignments',
      'task_attendance_events', 'task_status_history', 'payment_intents', 'scan_events']) expect(await count(t), t).toBe(0);
    expect(await count('staff_assignments')).toBe(shifts);
    expect(await count('event_memberships')).toBe(members);
    expect(await count('packages')).toBe(2);
    expect(await must<{ id: string; status: string }[]>(db().from('stations').select('id, status').eq('event_id', fx.eventId).order('id'))).toEqual(stationsBefore);
    expect((await must<{ status: string }>(db().from('events').select('status').eq('id', fx.eventId).single())).status).toBe('paused');
    expect(await must<unknown[]>(db().from('audit_logs').select('id').eq('event_id', fx.eventId).eq('action', 'event.reset_operations'))).toHaveLength(1);

    // drill 2: straight back to live, codes and tickets restart, the first patient is auto-queued
    await must(admin().rpc('set_event_status', { p_event: fx.eventId, p_status: 'live', p_reason: 'drill 2' }));
    const r2 = await register(fx, 'female');
    expect(r2.registration_code).toMatch(/0*1$/);
    const a = await activeAssignment(r2.registration_id);
    expect(a).toBeDefined();
    expect(a.seq).toBe(1);
  });
});
