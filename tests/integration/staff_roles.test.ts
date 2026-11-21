import { beforeAll, describe, expect, it } from 'vitest';
import { buildEvent, ensureUser, type Fixture } from '../../scripts/lib/fixture.ts';
import { must, newCode } from './helpers.ts';

let fx: Fixture;
beforeAll(async () => { fx = await buildEvent({ code: newCode('ROLES'), live: false }); });

const perms = async (c: Fixture['platform']['client'], ev: string) => new Set(await must<string[]>(c.rpc('my_permissions', { p_event: ev })));

describe('several roles per person (as an Event Admin, not the platform owner)', () => {
  it('the old upsert was refused — the cause of "permission denied for table event_memberships"', async () => {
    const { error } = await fx.users.event_admin.client.from('event_memberships').upsert(
      { event_id: fx.eventId, user_id: fx.users.addon_staff.id, role_code: 'cashier', active: true, created_by: fx.users.event_admin.id },
      { onConflict: 'event_id,user_id,role_code' });
    expect(error?.message).toMatch(/permission denied/);
  });

  it('adding, removing and restoring a second role works and changes what the person can do', async () => {
    const admin = fx.users.event_admin.client; const who = fx.users.addon_staff;
    expect((await perms(who.client, fx.eventId)).has('payment.verify')).toBe(false);
    // what grantRole does: insert when new …
    await must(admin.from('event_memberships').insert({ event_id: fx.eventId, user_id: who.id, role_code: 'cashier', created_by: fx.users.event_admin.id }));
    expect((await perms(who.client, fx.eventId)).has('payment.verify')).toBe(true);
    expect((await perms(who.client, fx.eventId)).has('addon.create')).toBe(true);        // both roles at once
    const row = await must<{ id: string }>(admin.from('event_memberships').select('id').eq('event_id', fx.eventId).eq('user_id', who.id).eq('role_code', 'cashier').single());
    await must(admin.from('event_memberships').update({ active: false }).eq('id', row.id));
    expect((await perms(who.client, fx.eventId)).has('payment.verify')).toBe(false);
    // … and only flip `active` when they had it before
    await must(admin.from('event_memberships').update({ active: true }).eq('id', row.id));
    expect((await perms(who.client, fx.eventId)).has('payment.verify')).toBe(true);
  });
});

describe('job roles', () => {
  it('a phlebotomist can work at a station, not register or take payments; role edits apply immediately', async () => {
    const admin = fx.users.event_admin.client;
    const phleb = await ensureUser(`phlebotomist@${fx.eventCode.toLowerCase()}.example.test`, 'Phlebotomist (synthetic)');
    await must(admin.from('event_memberships').insert({ event_id: fx.eventId, user_id: phleb.id, role_code: 'phlebotomist', created_by: fx.users.event_admin.id }));
    let p = await perms(phleb.client, fx.eventId);
    expect(p.has('task.perform')).toBe(true);
    expect(p.has('registration.create')).toBe(false);
    expect(p.has('payment.verify')).toBe(false);
    await must(admin.rpc('assign_staff', { p_station: fx.stations['S-01'], p_user: phleb.id, p_start: new Date().toISOString(), p_end: new Date(Date.now() + 3600_000).toISOString() }));

    await must(admin.from('role_permissions').delete().eq('event_id', fx.eventId).eq('role_code', 'phlebotomist').eq('permission_code', 'task.perform'));
    p = await perms(phleb.client, fx.eventId);
    expect(p.has('task.perform')).toBe(false);                                           // no re-login needed
    await must(admin.from('role_permissions').insert({ event_id: fx.eventId, role_code: 'phlebotomist', permission_code: 'task.perform' }));
    expect((await perms(phleb.client, fx.eventId)).has('task.perform')).toBe(true);
  });
});
