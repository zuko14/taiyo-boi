'use server';
import { revalidatePath } from 'next/cache';
import { getEventContext } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { bool, go, intOrNull, safePath, str, strOrNull } from '@/lib/flash';
import { localInputToIso, toPaise } from '@/lib/format';
import { createClient, serviceClient } from '@/lib/supabase/server';

async function admin(fd: FormData) {
  const eventId = str(fd, 'event_id');
  const ctx = await getEventContext(eventId);
  const back = safePath(str(fd, 'back'), `/e/${eventId}`);
  const db = await createClient(strOrNull(fd, 'reason'));    // reason reaches the audit trigger
  const done = (error: { message: string; code?: string } | null, ok = 'Saved') => {
    if (error) go(back, 'err', friendlyError(error));
    revalidatePath(back.split('?')[0]);
    go(back, 'ok', ok);
  };
  return { eventId, ctx, back, db, done };
}

const iso = (fd: FormData, k: string, tz: string) => (str(fd, k) ? localInputToIso(str(fd, k), tz) : null);

export async function saveEventProfile(fd: FormData) {
  const { eventId, ctx, db, done } = await admin(fd);
  const tz = str(fd, 'timezone') || ctx.event.timezone;
  const { error } = await db.from('events').update({
    name: str(fd, 'name'), sponsor_name: str(fd, 'sponsor_name'), lab_partner_name: str(fd, 'lab_partner_name'),
    venue: str(fd, 'venue'), help_contact: str(fd, 'help_contact'), portal_instructions: str(fd, 'portal_instructions'),
    timezone: tz, starts_at: iso(fd, 'starts_at', tz), ends_at: iso(fd, 'ends_at', tz),
    registration_opens_at: iso(fd, 'registration_opens_at', tz), registration_closes_at: iso(fd, 'registration_closes_at', tz),
    expected_attendance: intOrNull(fd, 'expected_attendance') ?? 500, code_prefix: str(fd, 'code_prefix').toUpperCase(),
    code_year: intOrNull(fd, 'code_year'), code_format: str(fd, 'code_format'), code_seq_digits: intOrNull(fd, 'code_seq_digits') ?? 6,
  }).eq('id', eventId);
  done(error, 'Event profile saved');
}

export async function saveEventSettings(fd: FormData) {
  const { eventId, ctx, db, done } = await admin(fd);
  const methods = fd.getAll('payment_methods').map(String).filter(Boolean);
  const extra = str(fd, 'payment_methods_extra').split(',').map((m) => m.trim().toLowerCase().replace(/[^a-z0-9_]/g, '')).filter(Boolean);
  const settings = {
    ...ctx.event.settings,
    require_consent: bool(fd, 'require_consent'), payment_maker_checker: bool(fd, 'payment_maker_checker'),
    report_maker_checker: bool(fd, 'report_maker_checker'), portal_otp_required: true,
    grouping_approved: bool(fd, 'grouping_approved'), payment_methods: [...new Set([...methods, ...extra])],
    payment_instructions: str(fd, 'payment_instructions'), default_service_minutes: intOrNull(fd, 'default_service_minutes') ?? 5,
    label: { width_mm: intOrNull(fd, 'label_w') ?? 90, height_mm: intOrNull(fd, 'label_h') ?? 55, show_age: bool(fd, 'label_show_age') },
  };
  const { error } = await db.from('events').update({ settings }).eq('id', eventId);
  done(error, 'Settings saved');
}

export async function saveTest(fd: FormData) {
  const { eventId, db, done, back } = await admin(fd);
  const id = strOrNull(fd, 'id');
  const row = {
    event_id: eventId, code: str(fd, 'code').toUpperCase(), display_name: str(fd, 'display_name'), category: str(fd, 'category'),
    lab_order_code: strOrNull(fd, 'lab_order_code'), instructions: str(fd, 'instructions'), location: str(fd, 'location'),
    active: bool(fd, 'active'), archived: bool(fd, 'archived'), addon_available: bool(fd, 'addon_available'),
    ...(id ? {} : { source_wording: str(fd, 'display_name') }),
  };
  const res = id ? await db.from('test_catalog').update(row).eq('id', id).select('id').single() : await db.from('test_catalog').insert(row).select('id').single();
  if (res.error) go(back, 'err', friendlyError(res.error));
  const service = strOrNull(fd, 'service_id');
  const testId = res.data!.id;
  const { data: cur } = await db.from('workflow_service_tests').select('service_id, completion_rule').eq('test_id', testId).maybeSingle();
  const rule = str(fd, 'completion_rule') || 'fulfilled_on_complete';
  if (cur && (cur.service_id !== service || cur.completion_rule !== rule)) {
    const { error } = await db.from('workflow_service_tests').delete().eq('test_id', testId);
    if (error) go(back, 'err', friendlyError(error));
  }
  if (service && (!cur || cur.service_id !== service || cur.completion_rule !== rule)) {
    const { error } = await db.from('workflow_service_tests').insert({ event_id: eventId, service_id: service, test_id: testId, completion_rule: rule });
    if (error) go(back, 'err', friendlyError(error));
  }
  done(null, 'Test saved');
}

export async function saveService(fd: FormData) {
  const { eventId, db, done } = await admin(fd);
  const id = strOrNull(fd, 'id');
  const row = { event_id: eventId, code: str(fd, 'code').toUpperCase(), name: str(fd, 'name'), location: str(fd, 'location'),
    priority: intOrNull(fd, 'priority') ?? 100, est_minutes: intOrNull(fd, 'est_minutes'), instructions: str(fd, 'instructions'), active: bool(fd, 'active') };
  const { error } = id ? await db.from('workflow_services').update(row).eq('id', id) : await db.from('workflow_services').insert(row);
  done(error, 'Service saved');
}

export async function savePackage(fd: FormData) {
  const { db, done } = await admin(fd);
  const { error } = await db.from('packages').update({ name: str(fd, 'name'), description: str(fd, 'description'),
    code_letter: str(fd, 'code_letter').toUpperCase(), eligibility_note: str(fd, 'eligibility_note'), active: bool(fd, 'active') }).eq('id', str(fd, 'id'));
  done(error, 'Package saved');
}

export async function addPackageTest(fd: FormData) {
  const { eventId, db, done } = await admin(fd);
  const { error } = await db.from('package_tests').insert({ event_id: eventId, package_id: str(fd, 'package_id'), test_id: str(fd, 'test_id'),
    choice_group_id: strOrNull(fd, 'choice_group_id') });
  done(error, 'Test added to package (applies to new registrations)');
}

export async function savePackageTest(fd: FormData) {
  const { db, done } = await admin(fd);
  const { error } = await db.from('package_tests').update({ priority: intOrNull(fd, 'priority') ?? 100, fasting_required: bool(fd, 'fasting_required'),
    required: bool(fd, 'required'), depends_on_test_ids: fd.getAll('depends_on').map(String).filter(Boolean),
    est_minutes: intOrNull(fd, 'est_minutes') }).eq('id', str(fd, 'id'));
  done(error, 'Package test saved');
}

export async function removePackageTest(fd: FormData) {
  const { db, done } = await admin(fd);
  const { error } = await db.from('package_tests').delete().eq('id', str(fd, 'id'));
  done(error, 'Removed from package (existing registrations keep their snapshot)');
}

export async function saveChoiceGroup(fd: FormData) {
  const { eventId, db, done } = await admin(fd);
  const id = strOrNull(fd, 'id');
  const row = { event_id: eventId, package_id: str(fd, 'package_id'), code: str(fd, 'code').toUpperCase(), name: str(fd, 'name'),
    rule: str(fd, 'rule'), separate_tasks: bool(fd, 'separate_tasks'), service_id: str(fd, 'service_id'), required: true };
  const { error } = id ? await db.from('choice_groups').update(row).eq('id', id) : await db.from('choice_groups').insert(row);
  done(error, 'Choice group saved');
}

export async function savePrice(fd: FormData) {
  const { eventId, ctx, db, done, back } = await admin(fd);
  let price = 0, tax = 0;
  try { price = toPaise(str(fd, 'price')); tax = toPaise(str(fd, 'tax') || '0'); } catch (e) { go(back, 'err', (e as Error).message); }
  const { error } = await db.from('addon_prices').insert({ event_id: eventId, test_id: str(fd, 'test_id'), price_paise: price, tax_paise: tax,
    location_scope: str(fd, 'location_scope'), require_payment_before_service: bool(fd, 'require_payment'),
    effective_from: iso(fd, 'effective_from', ctx.event.timezone) ?? new Date().toISOString(), effective_to: iso(fd, 'effective_to', ctx.event.timezone) });
  done(error, 'Price added (existing orders keep their price snapshot)');
}

export async function deactivatePrice(fd: FormData) {
  const { db, done } = await admin(fd);
  const { error } = await db.from('addon_prices').update({ active: false }).eq('id', str(fd, 'id'));
  done(error, 'Price deactivated');
}

export async function saveStation(fd: FormData) {
  const { eventId, db, done, back } = await admin(fd);
  const id = strOrNull(fd, 'id');
  const row = { name: str(fd, 'name'), location: str(fd, 'location'), instructions: str(fd, 'instructions'), address: str(fd, 'address'),
    operating_hours: str(fd, 'operating_hours'), valid_from: strOrNull(fd, 'valid_from'), valid_to: strOrNull(fd, 'valid_to'),
    capacity: intOrNull(fd, 'capacity') ?? 1, avg_service_minutes: intOrNull(fd, 'avg_service_minutes'), max_queue: intOrNull(fd, 'max_queue'),
    accepts_assignments: bool(fd, 'accepts_assignments') };
  const res = id ? await db.from('stations').update(row).eq('id', id).select('id').single()
    : await db.from('stations').insert({ ...row, event_id: eventId, code: str(fd, 'code').toUpperCase(), kind: str(fd, 'kind') }).select('id').single();
  if (res.error) go(back, 'err', friendlyError(res.error));
  if (fd.has('caps_present')) {
    const want = new Set(fd.getAll('caps').map(String));
    const { data: cur } = await db.from('station_capabilities').select('service_id').eq('station_id', res.data!.id);
    const have = new Set((cur ?? []).map((c) => c.service_id));
    for (const s of have) if (!want.has(s)) { const { error } = await db.from('station_capabilities').delete().eq('station_id', res.data!.id).eq('service_id', s); if (error) go(back, 'err', friendlyError(error)); }
    for (const s of want) if (!have.has(s)) { const { error } = await db.from('station_capabilities').insert({ event_id: eventId, station_id: res.data!.id, service_id: s }); if (error) go(back, 'err', friendlyError(error)); }
  }
  done(null, 'Station saved');
}

export async function createStaff(fd: FormData) {
  const { eventId, ctx, db, back } = await admin(fd);
  if (!ctx.can('staff.manage')) go(back, 'err', 'You do not have permission for this action.');
  const email = str(fd, 'email').toLowerCase(); const password = str(fd, 'password');
  if (password.length < 12) go(back, 'err', 'Initial password must be at least 12 characters.');
  const svc = serviceClient();
  // account creation needs the service role; authorisation was checked above and membership goes through RLS
  const created = await svc.auth.admin.createUser({ email, password, email_confirm: true });
  let userId = created.data.user?.id;
  if (!userId) {
    const { data: existing } = await svc.from('staff_profiles').select('user_id').eq('email', email).maybeSingle();
    userId = existing?.user_id;
    if (!userId) go(back, 'err', 'Could not create the account (it may exist without a staff profile).');
  } else {
    const { error } = await svc.from('staff_profiles').insert({ user_id: userId, email, full_name: str(fd, 'full_name') });
    if (error) go(back, 'err', friendlyError(error));
  }
  const { error } = await db.from('event_memberships').insert({ event_id: eventId, user_id: userId, role_code: str(fd, 'role'), created_by: ctx.user.id });
  if (error) go(back, 'err', friendlyError(error));
  await svc.from('audit_logs').insert({ event_id: eventId, actor_id: ctx.user.id, action: 'staff.create', entity_type: 'staff', entity_id: userId, meta: { email, role: str(fd, 'role') } });
  go(back, 'ok', `Staff account ready for ${email}. Share the initial password privately and ask them to change it.`);
}

export async function addRole(fd: FormData) {
  const { eventId, ctx, db, done } = await admin(fd);
  const { error } = await db.from('event_memberships').upsert({ event_id: eventId, user_id: str(fd, 'user_id'), role_code: str(fd, 'role'), active: true, created_by: ctx.user.id },
    { onConflict: 'event_id,user_id,role_code' });
  done(error, 'Role added');
}

export async function setMembershipActive(fd: FormData) {
  const { db, done } = await admin(fd);
  const { error } = await db.from('event_memberships').update({ active: bool(fd, 'active') }).eq('id', str(fd, 'id'));
  done(error, 'Membership updated');
}

export async function setRolePermissions(fd: FormData) {
  const { eventId, db, done, back } = await admin(fd);
  const role = str(fd, 'role');
  const want = new Set(fd.getAll('perm').map(String));
  const { data: cur } = await db.from('role_permissions').select('permission_code').eq('event_id', eventId).eq('role_code', role);
  const have = new Set((cur ?? []).map((c) => c.permission_code));
  const del = [...have].filter((p) => !want.has(p)); const add = [...want].filter((p) => !have.has(p));
  if (del.length) { const { error } = await db.from('role_permissions').delete().eq('event_id', eventId).eq('role_code', role).in('permission_code', del); if (error) go(back, 'err', friendlyError(error)); }
  if (add.length) { const { error } = await db.from('role_permissions').insert(add.map((p) => ({ event_id: eventId, role_code: role, permission_code: p }))); if (error) go(back, 'err', friendlyError(error)); }
  done(null, `Permissions for ${role.replace(/_/g, ' ')} saved (${add.length} added, ${del.length} removed)`);
}

export async function setOverride(fd: FormData) {
  const { eventId, ctx, db, done } = await admin(fd);
  const mode = str(fd, 'mode');
  const key = { event_id: eventId, user_id: str(fd, 'user_id'), permission_code: str(fd, 'permission') };
  const { error } = mode === 'remove'
    ? await db.from('member_permission_overrides').delete().match(key)
    : await db.from('member_permission_overrides').upsert({ ...key, granted: mode === 'grant', created_by: ctx.user.id });
  done(error, 'Individual permission updated');
}
