// Builds a synthetic event through the real RPCs / RLS paths. Used by the seed script and tests.
// SYNTHETIC DATA ONLY — never use for real participants.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type Role =
  | 'event_admin' | 'registration_supervisor' | 'registration_staff' | 'addon_staff' | 'cashier'
  | 'station_supervisor' | 'station_staff' | 'walkin_staff' | 'report_manager' | 'finance_viewer' | 'sponsor_viewer';

export const ROLES: Role[] = ['event_admin', 'registration_supervisor', 'registration_staff', 'addon_staff', 'cashier',
  'station_supervisor', 'station_staff', 'walkin_staff', 'report_manager', 'finance_viewer', 'sponsor_viewer'];

export interface StaffUser { id: string; email: string; client: SupabaseClient }

export function env() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const password = process.env.SEED_PASSWORD!;
  if (!url || !anon || !service || !password) throw new Error('Supabase env not loaded');
  return { url, anon, service, password };
}

export function serviceClient(): SupabaseClient {
  const { url, service } = env();
  return createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function must<T = any>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(JSON.stringify(error));
  return data as T;
}

export async function ensureUser(email: string, fullName: string, platformAdmin = false): Promise<StaffUser> {
  const { url, anon, password } = env();
  const svc = serviceClient();
  let id: string | undefined;
  const created = await svc.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.data.user) id = created.data.user.id;
  else {
    const list = await svc.auth.admin.listUsers({ perPage: 1000 });
    id = list.data.users.find((u) => u.email === email)?.id;
  }
  if (!id) throw new Error(`could not create ${email}: ${created.error?.message}`);
  await must(svc.from('staff_profiles').upsert({ user_id: id, email, full_name: fullName, is_platform_admin: platformAdmin }));
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return { id, email, client };
}

interface StationSpec { code: string; name: string; kind: string; services?: string[]; location?: string; address?: string; hours?: string }

export const DEFAULT_STATIONS: StationSpec[] = [
  { code: 'REG-1', name: 'Registration Counter 1', kind: 'registration_counter', location: 'Entrance hall' },
  { code: 'REG-2', name: 'Registration Counter 2', kind: 'registration_counter', location: 'Entrance hall' },
  { code: 'ADD-1', name: 'Add-on Desk 1', kind: 'addon_desk', location: 'Entrance hall' },
  { code: 'S-01', name: 'Sample Collection 01', kind: 'station', services: ['SAMPLE'], location: 'Hall A' },
  { code: 'S-02', name: 'Sample Collection 02', kind: 'station', services: ['SAMPLE'], location: 'Hall A' },
  { code: 'S-03', name: 'Sample Collection 03', kind: 'station', services: ['SAMPLE'], location: 'Hall A' },
  { code: 'ECG-1', name: 'ECG Room 1', kind: 'station', services: ['ECG'], location: 'Room 3' },
  { code: 'ECG-2', name: 'ECG Room 2', kind: 'station', services: ['ECG'], location: 'Room 4' },
  { code: 'XR-1', name: 'X-Ray Unit', kind: 'station', services: ['XRAY'], location: 'Mobile van' },
  { code: 'BMD-1', name: 'BMD Station', kind: 'station', services: ['BMD'], location: 'Room 5' },
  { code: 'BC-1', name: 'Body Composition', kind: 'station', services: ['BODYCOMP'], location: 'Room 5' },
  { code: 'WI-1', name: 'Walk-in Centre (name to be confirmed)', kind: 'walkin_centre', services: ['USG'],
    address: 'Address to be confirmed by Lab Partner', hours: 'To be confirmed' },
];

export interface Fixture {
  eventId: string;
  eventCode: string;
  users: Record<Role, StaffUser>;
  platform: StaffUser;
  stations: Record<string, string>;
  services: Record<string, string>;
  tests: Record<string, string>;
  packages: Record<string, string>;
}

export async function buildEvent(opts: { code: string; name?: string; emailDomain?: string; stations?: StationSpec[]; live?: boolean }): Promise<Fixture> {
  const domain = opts.emailDomain ?? `${opts.code.toLowerCase()}.example.test`;
  const platform = await ensureUser(`platform@${domain}`, 'Platform Admin (synthetic)', true);
  const a = platform.client;
  const eventId = await must<string>(a.rpc('create_event', { p_code: opts.code, p_name: opts.name ?? `Synthetic camp ${opts.code}` }));
  await must(a.rpc('apply_brochure_template', { p_event: eventId }));
  await must(a.from('events').update({
    venue: 'Synthetic venue', help_contact: 'Help desk at entrance (synthetic)',
    settings: { require_consent: true, payment_maker_checker: true, report_maker_checker: true,
      payment_methods: ['cash', 'upi_manual'], portal_otp_required: true, default_service_minutes: 5, grouping_approved: false },
  }).eq('id', eventId));

  const services = Object.fromEntries((await must<{ id: string; code: string }[]>(
    a.from('workflow_services').select('id, code').eq('event_id', eventId))).map((s) => [s.code, s.id]));
  const tests = Object.fromEntries((await must<{ id: string; code: string }[]>(
    a.from('test_catalog').select('id, code').eq('event_id', eventId))).map((s) => [s.code, s.id]));
  const packages = Object.fromEntries((await must<{ id: string; classification: string }[]>(
    a.from('packages').select('id, classification').eq('event_id', eventId))).map((s) => [s.classification, s.id]));

  const stations: Record<string, string> = {};
  for (const s of opts.stations ?? DEFAULT_STATIONS) {
    const row = await must<{ id: string }>(a.from('stations').insert({
      event_id: eventId, code: s.code, name: s.name, kind: s.kind, location: s.location ?? '',
      address: s.address ?? '', operating_hours: s.hours ?? '',
    }).select('id').single());
    stations[s.code] = row.id;
    for (const svc of s.services ?? []) {
      await must(a.from('station_capabilities').insert({ event_id: eventId, station_id: row.id, service_id: services[svc] }));
    }
  }

  const users = {} as Record<Role, StaffUser>;
  for (const role of ROLES) {
    const u = await ensureUser(`${role.replace(/_/g, '.')}@${domain}`, `${role.replace(/_/g, ' ')} (synthetic)`);
    await must(a.from('event_memberships').insert({ event_id: eventId, user_id: u.id, role_code: role, created_by: platform.id }));
    users[role] = u;
  }

  const start = new Date(Date.now() - 3600_000).toISOString();
  const end = new Date(Date.now() + 12 * 3600_000).toISOString();
  const shiftFor = (kind: string): Role[] =>
    kind === 'registration_counter' ? ['registration_staff', 'registration_supervisor']
      : kind === 'addon_desk' ? ['addon_staff']
      : kind === 'walkin_centre' ? ['walkin_staff'] : ['station_staff'];
  for (const s of opts.stations ?? DEFAULT_STATIONS) {
    for (const role of shiftFor(s.kind)) {
      await must(a.rpc('assign_staff', { p_station: stations[s.code], p_user: users[role].id, p_start: start, p_end: end }));
    }
    await must(a.rpc('station_set_status', { p_station: stations[s.code], p_status: 'open', p_reason: null }));
  }
  if (opts.live !== false) {
    await must(a.rpc('set_event_status', { p_event: eventId, p_status: 'live', p_reason: null }));
  }
  return { eventId, eventCode: opts.code, users, platform, stations, services, tests, packages };
}
