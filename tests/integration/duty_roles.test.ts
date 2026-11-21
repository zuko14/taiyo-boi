import { beforeAll, describe, expect, it } from 'vitest';
import { buildEvent, ensureUser, type Fixture } from '../../scripts/lib/fixture.ts';
import { db, must, newCode } from './helpers.ts';

let fx: Fixture; let ev: string; const st: Record<string, string> = {};
const start = () => new Date(Date.now() - 60_000).toISOString();
const end = () => new Date(Date.now() + 3600_000).toISOString();
const roles = async (u: string) => (await must<{ role_code: string }[]>(db().from('event_memberships').select('role_code').eq('event_id', ev).eq('user_id', u).eq('active', true))).map((r) => r.role_code).sort();
const perms = async (c: Fixture['platform']['client']) => new Set(await must<string[]>(c.rpc('my_permissions', { p_event: ev })));

beforeAll(async () => {
  fx = await buildEvent({ code: newCode('DUTY') });   // Bank of India fixture (sponsored) for the separation check
  const a = fx.platform.client;
  ev = await must<string>(a.rpc('create_event', { p_code: newCode('DT'), p_name: 'Duty camp' }));
  await must(a.from('events').update({ settings: { package_mode: 'custom', payment_model: 'patient_pays', payment_methods: ['cash'] } }).eq('id', ev));
  const blood = await must<string>(a.rpc('ensure_service', { p_event: ev, p_name: 'Blood sample collection', p_location: 'event_day' }));
  const echo = await must<string>(a.rpc('ensure_service', { p_event: ev, p_name: '2D Echo', p_location: 'event_day' }));
  const bmd = await must<string>(a.rpc('ensure_service', { p_event: ev, p_name: 'BMD', p_location: 'event_day' }));
  for (const [code, kind, cap] of [['B1', 'station', blood], ['E1', 'station', echo], ['M1', 'station', bmd], ['R1', 'registration_counter', null]] as const) {
    st[code] = (await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code, name: code, kind }).select('id').single())).id;
    if (cap) await must(a.from('station_capabilities').insert({ event_id: ev, station_id: st[code], service_id: cap }));
  }
});

const newcomer = async (tag: string, role = 'sponsor_viewer') => {
  const u = await ensureUser(`${tag}-${Date.now()}@${fx.eventCode.toLowerCase()}.example.test`, `${tag} (synthetic)`);
  await must(db().from('event_memberships').insert({ event_id: ev, user_id: u.id, role_code: role }));
  return u;
};
const assign = (station: string, user: string) => must(fx.platform.client.rpc('assign_staff', { p_station: station, p_user: user, p_start: start(), p_end: end() }));

describe('a shift brings the access its station needs', () => {
  it('blood station → phlebotomist; 2D Echo room → radiology technician; other station → technician', async () => {
    const a = await newcomer('blood'); await assign(st.B1, a.id);
    expect(await roles(a.id)).toEqual(['phlebotomist', 'sponsor_viewer']);
    expect((await perms(a.client)).has('task.perform')).toBe(true);
    const b = await newcomer('echo'); await assign(st.E1, b.id);
    expect(await roles(b.id)).toContain('radiology_technician');
    const c = await newcomer('bmd'); await assign(st.M1, c.id);
    expect(await roles(c.id)).toContain('station_staff');
    // already able: nothing extra
    await assign(st.E1, a.id);
    expect(await roles(a.id)).toEqual(['phlebotomist', 'sponsor_viewer']);
  });

  it('patient-pays registration counter → registration desk + cashier', async () => {
    const u = await newcomer('reg'); await assign(st.R1, u.id);
    expect(await roles(u.id)).toEqual(['cashier', 'registration_staff', 'sponsor_viewer']);
    const p = await perms(u.client);
    expect(p.has('registration.create') && p.has('payment.verify')).toBe(true);
  });

  it('a removed role comes back with a shift; an explicit individual revoke still wins', async () => {
    const u = await newcomer('removed', 'phlebotomist');
    await must(db().from('event_memberships').update({ active: false }).eq('event_id', ev).eq('user_id', u.id));
    await assign(st.B1, u.id);                                  // no active role left, still assignable
    expect(await roles(u.id)).toEqual(['phlebotomist']);
    const r = await newcomer('revoked');
    await must(db().from('member_permission_overrides').insert({ event_id: ev, user_id: r.id, permission_code: 'task.perform', granted: false }));
    await assign(st.B1, r.id);
    expect((await perms(r.client)).has('task.perform')).toBe(false);
  });

  it('Bank of India (sponsored): the add-on desk does not get payment verification', async () => {
    const p = new Set(await must<string[]>(fx.users.addon_staff.client.rpc('my_permissions', { p_event: fx.eventId })));
    expect(p.has('addon.create')).toBe(true);
    expect(p.has('payment.verify')).toBe(false);
    const audit = await must<unknown[]>(db().from('audit_logs').select('id').eq('event_id', ev).eq('action', 'staff.role_auto'));
    expect(audit.length).toBeGreaterThanOrEqual(5);
  });
});
