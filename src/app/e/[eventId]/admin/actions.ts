'use server';
import { revalidatePath } from 'next/cache';
import { getEventContext } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { bool, go, intOrNull, safePath, str, strOrNull } from '@/lib/flash';
import { localInputToIso, toPaise } from '@/lib/format';
import { createClient, serviceClient } from '@/lib/supabase/server';
import { VPA_RE } from '@/lib/upi';
import { codeFromName, mapCatalog, mapPackages, parseCsv } from '@/lib/catalog-import';

async function admin(fd: FormData, defaultReason?: string) {
  const eventId = str(fd, 'event_id');
  const ctx = await getEventContext(eventId);
  const back = safePath(str(fd, 'back'), `/e/${eventId}`);
  const reason = strOrNull(fd, 'reason') || defaultReason || null;
  const db = await createClient(reason);    // reason reaches the audit trigger
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
  // payment model, methods and UPI details are saved by savePaymentSetup and kept here as they are
  const settings = {
    ...ctx.event.settings,
    require_consent: bool(fd, 'require_consent'), payment_maker_checker: bool(fd, 'payment_maker_checker'),
    report_maker_checker: bool(fd, 'report_maker_checker'), portal_otp_required: true,
    grouping_approved: bool(fd, 'grouping_approved'), default_service_minutes: intOrNull(fd, 'default_service_minutes') ?? 5,
    label: { width_mm: intOrNull(fd, 'label_w') ?? 90, height_mm: intOrNull(fd, 'label_h') ?? 55, show_age: bool(fd, 'label_show_age') },
  };
  const { error } = await db.from('events').update({ settings }).eq('id', eventId);
  done(error, 'Settings saved');
}

/** Who pays at this camp, and how on-the-spot payments are received (UPI QR / cash). */
export async function savePaymentSetup(fd: FormData) {
  const { eventId, ctx, db, done, back } = await admin(fd);
  const fixed = ctx.event.settings.package_mode === 'female_male';
  const model = fixed ? 'sponsored' : str(fd, 'payment_model') === 'sponsored' ? 'sponsored' : 'patient_pays';
  const vpa = str(fd, 'upi_vpa').toLowerCase();
  if (vpa && !VPA_RE.test(vpa)) go(back, 'err', 'The UPI ID does not look valid. It looks like name@bank, e.g. taiyolabs@okicici — copy it exactly from the bank or UPI app.');
  const payee = str(fd, 'upi_payee_name').slice(0, 60);
  if (vpa && !payee) go(back, 'err', 'Enter the account holder name exactly as the bank shows it, so patients can check whom they are paying.');
  const extra = str(fd, 'payment_methods_extra').split(',').map((m) => m.trim().toLowerCase().replace(/[^a-z0-9_]/g, '')).filter(Boolean);
  // UPI by QR is a verifiable method only when a UPI ID is set; cash is opt-in
  const methods = [...new Set([...(bool(fd, 'accept_cash') ? ['cash'] : []), ...(vpa ? ['upi_manual'] : []), ...extra])];
  if (model === 'patient_pays' && !methods.length) go(back, 'err', 'Patients pay at this camp: add a UPI ID and/or accept cash, otherwise no payment can be confirmed.');
  const settings = { ...ctx.event.settings, payment_model: model, upi_vpa: vpa, upi_payee_name: payee, payment_methods: methods,
    payment_instructions: str(fd, 'payment_instructions') };
  const { error } = await db.from('events').update({ settings }).eq('id', eventId);
  done(error, 'Payment setup saved');
}

export async function saveTest(fd: FormData) {
  const { eventId, ctx, db, done, back } = await admin(fd);
  // a visit typed on the test form is created (or reused) first
  if (str(fd, 'new_service')) {
    const { data: sid, error } = await db.rpc('ensure_service', { p_event: eventId, p_name: str(fd, 'new_service'), p_location: str(fd, 'location') || 'event_day' });
    if (error) go(back, 'err', friendlyError(error));
    fd.set('service_id', sid as string);
  }
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
  // optional quick add-on price: replaces the active price (existing orders keep their snapshot)
  if (str(fd, 'price') && ctx.can('addon.price.edit')) {
    let price = 0;
    try { price = toPaise(str(fd, 'price')); } catch (e) { go(back, 'err', (e as Error).message); }
    const { data: cur } = await db.from('addon_prices').select('id, price_paise').eq('test_id', testId).eq('active', true);
    if (!(cur?.length === 1 && cur[0].price_paise === price)) {
      if (cur?.length) { const { error } = await db.from('addon_prices').update({ active: false }).in('id', cur.map((c) => c.id)); if (error) go(back, 'err', friendlyError(error)); }
      const { error } = await db.from('addon_prices').insert({ event_id: eventId, test_id: testId, price_paise: price });
      if (error) go(back, 'err', friendlyError(error));
    }
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

/** Replace a package's plain test list with the ticked tests (choice-group options are untouched). */
export async function setPackageTests(fd: FormData) {
  const { eventId, db, done, back } = await admin(fd, 'Package tests updated');
  const pkgId = str(fd, 'package_id');
  const want = [...new Set(fd.getAll('test_ids').map(String).filter(Boolean))];
  const [{ data: pkg }, { data: cur }, { data: tests }, { data: map }] = await Promise.all([
    db.from('packages').select('code, name').eq('id', pkgId).eq('event_id', eventId).single(),
    db.from('package_tests').select('id, test_id').eq('package_id', pkgId).is('choice_group_id', null),
    want.length ? db.from('test_catalog').select('id, display_name, active, archived').eq('event_id', eventId).in('id', want) : Promise.resolve({ data: [] }),
    want.length ? db.from('workflow_service_tests').select('test_id').eq('event_id', eventId).in('test_id', want) : Promise.resolve({ data: [] }),
  ]);
  if (!pkg) go(back, 'err', 'Package not found.');
  if (pkg.code === 'PAY_PER_TEST') go(back, 'err', 'The Pay per test package has no tests of its own.');
  if ((tests ?? []).length !== want.length) go(back, 'err', 'Some selected tests no longer exist. Reload the page and try again.');
  const have = new Set((cur ?? []).map((c) => c.test_id));
  const drop = (cur ?? []).filter((c) => !want.includes(c.test_id)).map((c) => c.id);
  const add = want.filter((id) => !have.has(id));
  // only newly added tests are checked; tests already in the package may stay as they are
  const adding = (tests ?? []).filter((t) => add.includes(t.id));
  const bad = adding.filter((t) => !t.active || t.archived).map((t) => t.display_name);
  if (bad.length) go(back, 'err', `Inactive or archived tests cannot be added: ${bad.join(', ')}`);
  const unlinked = adding.filter((t) => !(map ?? []).some((m) => m.test_id === t.id)).map((t) => t.display_name);
  if (unlinked.length) go(back, 'err', `Link these tests to a visit in the Test catalogue first, otherwise they cannot be queued: ${unlinked.join(', ')}`);
  if (drop.length) { const { error } = await db.from('package_tests').delete().in('id', drop); if (error) go(back, 'err', friendlyError(error)); }
  if (add.length) { const { error } = await db.from('package_tests').insert(add.map((test_id) => ({ event_id: eventId, package_id: pkgId, test_id }))); if (error) go(back, 'err', friendlyError(error)); }
  done(null, `${pkg.name}: ${add.length} added, ${drop.length} removed (applies to new registrations).`);
}

/** Create a test that is not in the catalogue yet (ECG, Ultrasound, 2D Echo…) and add it to a package. */
export async function addNewTestToPackage(fd: FormData) {
  const { eventId, ctx, db, done, back } = await admin(fd, 'Test created for a package');
  const pkgId = str(fd, 'package_id'); const name = str(fd, 'test_name').slice(0, 200);
  if (!name) go(back, 'err', 'Enter the test name.');
  let price: number | null = null;
  if (str(fd, 'price')) {
    try { price = toPaise(str(fd, 'price')); } catch (e) { go(back, 'err', (e as Error).message); }
    if (!ctx.can('addon.price.edit')) go(back, 'err', 'You may not set prices; leave the price empty.');
  }
  // the visit: chosen, typed, or (neither) named after the test itself, e.g. "2D Echo"
  let serviceId = strOrNull(fd, 'service_id');
  if (!serviceId) {
    const { data, error } = await db.rpc('ensure_service', { p_event: eventId, p_name: str(fd, 'new_service') || name, p_location: bool(fd, 'walk_in') ? 'walk_in' : 'event_day' });
    if (error) go(back, 'err', friendlyError(error));
    serviceId = data as string;
  }
  const { data: svc } = await db.from('workflow_services').select('code, location').eq('id', serviceId).eq('event_id', eventId).single();
  if (!svc) go(back, 'err', 'Visit not found.');
  // a fresh, unused code, so an existing test is never overwritten
  const base = codeFromName(name);
  const { data: taken } = await db.from('test_catalog').select('code').eq('event_id', eventId).like('code', `${base}%`);
  let code = base; for (let n = 2; (taken ?? []).some((t) => t.code === code); n++) code = `${base.slice(0, 37)}-${n}`;
  // one transaction: test + visit link + price
  const { error: impErr } = await db.rpc('import_catalog', { p_event: eventId, p_reason: strOrNull(fd, 'reason'), p_rows: [{ code, name, category: str(fd, 'category'),
    price_paise: price, location: svc.location, service_code: svc.code, lab_order_code: '', instructions: '' }] });
  if (impErr) go(back, 'err', friendlyError(impErr));
  const { data: t } = await db.from('test_catalog').select('id').eq('event_id', eventId).eq('code', code).single();
  const { error } = await db.from('package_tests').insert({ event_id: eventId, package_id: pkgId, test_id: t!.id });
  done(error, `${name} created and added to the package${error ? '' : ` (code ${code})`}.`);
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
  const kind = id ? (await db.from('stations').select('kind').eq('id', id).single()).data?.kind : str(fd, 'kind');
  // validate and resolve the services first, so a rejected form never leaves a half-saved station
  const want = new Set(fd.getAll('caps').map(String));
  if (fd.has('caps_present')) {
    // typed visits, comma-separated ("Ultrasound (USG), 2D Echo" = one room doing both); created or reused
    const fresh = str(fd, 'new_service').split(',').map((v) => v.trim()).filter(Boolean);
    // nothing ticked or typed: the station's own name is its visit (e.g. "Ultrasound USG")
    if (!want.size && !fresh.length) {
      if (!str(fd, 'name')) go(back, 'err', 'Give the station a name, or choose what it does.');
      fresh.push(str(fd, 'name'));
    }
    for (const v of fresh) {
      const { data: sid, error } = await db.rpc('ensure_service', { p_event: eventId, p_name: v, p_location: kind === 'walkin_centre' ? 'walk_in' : 'event_day' });
      if (error) go(back, 'err', friendlyError(error));
      want.add(sid as string);
    }
  }
  const row = { name: str(fd, 'name'), location: str(fd, 'location'), instructions: str(fd, 'instructions'), address: str(fd, 'address'),
    operating_hours: str(fd, 'operating_hours'), valid_from: strOrNull(fd, 'valid_from'), valid_to: strOrNull(fd, 'valid_to'),
    capacity: intOrNull(fd, 'capacity') ?? 1, avg_service_minutes: intOrNull(fd, 'avg_service_minutes'), max_queue: intOrNull(fd, 'max_queue'),
    accepts_assignments: bool(fd, 'accepts_assignments') };
  const res = id ? await db.from('stations').update(row).eq('id', id).select('id').single()
    : await db.from('stations').insert({ ...row, event_id: eventId, code: str(fd, 'code').toUpperCase(), kind }).select('id').single();
  if (res.error) go(back, 'err', friendlyError(res.error));
  if (fd.has('caps_present')) {
    const { data: cur } = await db.from('station_capabilities').select('service_id').eq('station_id', res.data!.id);
    const have = new Set((cur ?? []).map((c) => c.service_id));
    for (const s of have) if (!want.has(s)) { const { error } = await db.from('station_capabilities').delete().eq('station_id', res.data!.id).eq('service_id', s); if (error) go(back, 'err', friendlyError(error)); }
    for (const s of want) if (!have.has(s)) { const { error } = await db.from('station_capabilities').insert({ event_id: eventId, station_id: res.data!.id, service_id: s }); if (error) go(back, 'err', friendlyError(error)); }
  }
  done(null, 'Station saved');
}

export async function createStaff(fd: FormData) {
  const { eventId, ctx, db, back } = await admin(fd, 'Staff account created');
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
  const error = await grantRole(db, eventId, userId!, str(fd, 'role'), ctx.user.id);
  if (error) go(back, 'err', friendlyError(error));
  await svc.from('audit_logs').insert({ event_id: eventId, actor_id: ctx.user.id, action: 'staff.create', entity_type: 'staff', entity_id: userId, meta: { email, role: str(fd, 'role') } });
  go(back, 'ok', `Staff account ready for ${email}. Share the initial password privately and ask them to change it.`);
}

/**
 * Give a person a role: reactivate it if they had it before, otherwise add it. A person can hold any
 * number of roles. (Not an upsert: staff may only toggle `active`, and an upsert's ON CONFLICT
 * UPDATE needs update rights on every column, which failed with "permission denied".)
 */
async function grantRole(db: Awaited<ReturnType<typeof createClient>>, eventId: string, userId: string, role: string, actor: string) {
  const { data: cur, error: readErr } = await db.from('event_memberships').select('id, active')
    .eq('event_id', eventId).eq('user_id', userId).eq('role_code', role).maybeSingle();
  if (readErr) return readErr;
  if (cur?.active) return null;
  const { error } = cur ? await db.from('event_memberships').update({ active: true }).eq('id', cur.id)
    : await db.from('event_memberships').insert({ event_id: eventId, user_id: userId, role_code: role, created_by: actor });
  return error;
}

export async function addRole(fd: FormData) {
  const { eventId, ctx, db, done } = await admin(fd, 'Staff role added');
  done(await grantRole(db, eventId, str(fd, 'user_id'), str(fd, 'role'), ctx.user.id), 'Role added');
}

export async function setMembershipActive(fd: FormData) {
  const { db, done } = await admin(fd, 'Staff membership updated');
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

// ---------------------------------------------------------------- deletion and lifecycle

export async function deleteTest(fd: FormData) {
  const { db, done } = await admin(fd, 'Test deleted from catalogue');
  const { error } = await db.rpc('delete_test', { p_test: str(fd, 'id'), p_reason: strOrNull(fd, 'reason') });
  done(error, 'Test deleted');
}

export async function createPackage(fd: FormData) {
  const { eventId, db, back } = await admin(fd, 'Package created');
  const { data: id, error } = await db.rpc('create_package', { p_event: eventId, p_code: str(fd, 'code'), p_name: str(fd, 'name'),
    p_code_letter: str(fd, 'code_letter'), p_description: str(fd, 'description') });
  if (error) go(back, 'err', friendlyError(error));
  revalidatePath(back.split('?')[0]);
  go(`${back.split('?')[0]}?pkg=${id}`, 'ok', 'Package created. Now choose its tests.');      // straight into the new package
}

export async function deletePackage(fd: FormData) {
  const { db, done } = await admin(fd, 'Package deleted');
  const { error } = await db.rpc('delete_package', { p_package: str(fd, 'id'), p_reason: strOrNull(fd, 'reason') });
  done(error, 'Package deleted');
}

export async function setPackageRate(fd: FormData) {
  const { db, done, back } = await admin(fd, 'Package price changed');
  let amount: number | null = null;
  if (str(fd, 'price')) { try { amount = toPaise(str(fd, 'price')); } catch (e) { go(back, 'err', (e as Error).message); } }
  const { error } = await db.rpc('set_package_rate', { p_package: str(fd, 'id'), p_amount_paise: amount, p_reason: strOrNull(fd, 'reason') });
  done(error, amount == null ? 'Package price cleared' : 'Package price saved');
}

/** Remove report files from private storage after the database rows are gone. */
async function removeReportFiles(keys: string[] | null) {
  const list = keys ?? [];
  for (let i = 0; i < list.length; i += 100) {
    const { error } = await serviceClient().storage.from('reports').remove(list.slice(i, i + 100));
    // files are private and unreferenced; log and continue rather than fail an already-committed reset
    if (error) console.error('report file cleanup failed', { count: list.length, message: error.message });
  }
}

export async function resetEvent(fd: FormData) {
  const eventId = str(fd, 'event_id');
  const back = `/e/${eventId}/admin/event`;
  const ctx = await getEventContext(eventId);
  const { data, error } = await ctx.supabase.rpc('reset_event', { p_event: eventId, p_confirm_code: str(fd, 'confirm'), p_reason: str(fd, 'reason') });
  if (error) go(back, 'err', friendlyError(error));
  await removeReportFiles(data as string[] | null);
  revalidatePath(`/e/${eventId}`, 'layout');
  go(back, 'ok', 'Event reset: all participants, orders, queues and reports were removed. Configuration and staff are kept; status is Draft.');
}

export async function deleteEvent(fd: FormData) {
  const eventId = str(fd, 'event_id');
  const back = safePath(str(fd, 'back'), '/platform');
  const ctx = await getEventContext(eventId);
  if (!ctx.profile.is_platform_admin) go(back, 'err', 'Only a platform admin can delete an event.');
  const { data, error } = await ctx.supabase.rpc('delete_event', { p_event: eventId, p_confirm_code: str(fd, 'confirm') });
  if (error) go(back, 'err', friendlyError(error));
  await removeReportFiles(data as string[] | null);
  revalidatePath('/platform'); revalidatePath('/select-event');
  go('/platform', 'ok', `Event ${ctx.event.code} deleted permanently.`);
}

export async function importCatalog(fd: FormData) {
  const { eventId, db, done, back } = await admin(fd, 'Catalogue CSV import');
  const csv = str(fd, 'csv');
  if (!csv) go(back, 'err', 'Choose a CSV file first.');
  if (csv.length > 2_000_000) go(back, 'err', 'File is larger than 2 MB.');
  const { rows, errors } = mapCatalog(parseCsv(csv));       // never trust the browser preview
  if (errors.length) go(back, 'err', `Line ${errors[0].line}: ${errors[0].message}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`);
  const { data, error } = await db.rpc('import_catalog', { p_event: eventId, p_rows: rows.map((r) => ({ ...r, line: undefined })), p_reason: strOrNull(fd, 'reason') });
  if (error) go(back, 'err', friendlyError(error));
  const d = data as { created: number; updated: number; prices_changed: number };
  done(null, `Imported: ${d.created} new, ${d.updated} updated, ${d.prices_changed} price change(s).`);
}

export async function deleteStation(fd: FormData) {
  const { db, done } = await admin(fd, 'Station deleted');
  const { error } = await db.rpc('delete_station', { p_station: str(fd, 'id'), p_reason: strOrNull(fd, 'reason') });
  done(error, 'Station deleted');
}

export async function importPackages(fd: FormData) {
  const { eventId, db, done, back } = await admin(fd, 'Package CSV import');
  const csv = str(fd, 'csv');
  if (!csv) go(back, 'err', 'Choose a CSV file first.');
  if (csv.length > 2_000_000) go(back, 'err', 'File is larger than 2 MB.');
  const { rows, errors } = mapPackages(parseCsv(csv));       // never trust the browser preview
  if (errors.length) go(back, 'err', `Line ${errors[0].line}: ${errors[0].message}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`);
  const { data, error } = await db.rpc('import_packages', { p_event: eventId, p_rows: rows.map((r) => ({ ...r, line: undefined })), p_reason: strOrNull(fd, 'reason') });
  if (error) go(back, 'err', friendlyError(error));
  const d = data as { created: number; updated: number; tests: number };
  done(null, `Packages imported: ${d.created} new, ${d.updated} updated, ${d.tests} test line(s).`);
}
