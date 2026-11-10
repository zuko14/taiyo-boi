-- Row Level Security, grants, realtime publication and private storage.
-- Model: browsers authenticate as staff (role "authenticated"). Reads are RLS-scoped to the
-- event and permission. Operational writes only happen through SECURITY DEFINER functions.
-- Configuration tables accept direct writes guarded by permission policies + audit triggers.
-- anon gets nothing; the participant portal is served by the server using the service role.

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- grants
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke insert, update, delete, truncate on all tables in schema public from authenticated;
revoke all on public.sponsor_backend_rates, public.registration_tokens, public.portal_otps,
              public.portal_sessions, public.package_code_counters from authenticated;

grant insert, update on public.test_catalog to authenticated;
grant update (name, description, eligibility_note, active, active_from, active_to, code_letter) on public.packages to authenticated;
grant insert, update on public.workflow_services to authenticated;
grant insert, update, delete on public.workflow_service_tests, public.choice_groups, public.package_tests,
                                public.station_capabilities to authenticated;
grant insert, update on public.addon_prices to authenticated;
grant insert (event_id, code, name, kind, location, instructions, address, operating_hours, valid_from, valid_to,
              capacity, avg_service_minutes, max_queue, accepts_assignments) on public.stations to authenticated;
grant update (name, location, instructions, address, operating_hours, valid_from, valid_to,
              capacity, avg_service_minutes, max_queue, accepts_assignments) on public.stations to authenticated;
grant update (name, sponsor_name, lab_partner_name, venue, help_contact, portal_instructions, timezone, starts_at,
              ends_at, registration_opens_at, registration_closes_at, expected_attendance, code_prefix, code_year,
              code_format, code_seq_digits, settings) on public.events to authenticated;
grant insert, delete on public.role_permissions to authenticated;
grant insert, update, delete on public.member_permission_overrides to authenticated;
grant insert, update (active) on public.event_memberships to authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.is_platform_admin(), public.is_member(uuid), public.has_perm(uuid, text), public.my_permissions(uuid),
  public.request_header(text), public.request_reason(), public.event_setting(uuid, text),
  public.register_participant(uuid, text, text, text, int, text, text, text, text, boolean, uuid, text),
  public.find_possible_duplicates(uuid, text, text, text),
  public.correct_registration(uuid, text, int, text, text, text, text, text),
  public.resolve_duplicate(uuid, uuid, text),
  public.migrate_registration_config(uuid, text),
  public.select_choice(uuid, uuid, uuid[], text),
  public.task_action(uuid, text, uuid, text),
  public.confirm_order_item(uuid, uuid, text),
  public.call_next(uuid),
  public.reassign_task(uuid, uuid, text),
  public.rebalance_waiting(uuid),
  public.grant_payment_exception(uuid, text),
  public.station_set_status(uuid, text, text),
  public.assign_staff(uuid, uuid, timestamptz, timestamptz),
  public.end_staff_assignment(uuid, text),
  public.issue_tag(uuid, text, text),
  public.confirm_tag_printed(uuid),
  public.revoke_tag(uuid, text),
  public.resolve_scan(uuid, text, text, uuid),
  public.create_addon_order(uuid, uuid, uuid[], text, boolean),
  public.verify_payment(uuid, text, text, bigint, text),
  public.payment_action(uuid, text, text, bigint, text),
  public.report_create(uuid, text, text, text, int, text, text),
  public.report_action(uuid, text, text),
  public.create_event(text, text, text),
  public.apply_brochure_template(uuid),
  public.validate_event(uuid),
  public.set_event_status(uuid, text, text),
  public.dashboard_overview(uuid),
  public.test_attendance(uuid, text),
  public.sponsor_summary(uuid),
  public.addon_revenue(uuid),
  public.staff_directory(uuid)
to authenticated;
-- trigger functions run as table owner; portal_* and _internal functions stay service-role only

-- ---------------------------------------------------------------- policies: reference data
create policy read_all on public.permissions for select to authenticated using (true);
create policy read_all on public.roles for select to authenticated using (true);
create policy read_all on public.default_role_permissions for select to authenticated using (true);

create policy member_read on public.events for select to authenticated using (public.is_member(id));
create policy configure on public.events for update to authenticated
  using (public.has_perm(id, 'event.configure')) with check (public.has_perm(id, 'event.configure'));

create policy staff_read on public.staff_profiles for select to authenticated using (
  user_id = auth.uid() or public.is_platform_admin()
  or exists (select 1 from public.event_memberships m where m.user_id = staff_profiles.user_id
             and (public.has_perm(m.event_id, 'staff.manage') or public.has_perm(m.event_id, 'shift.assign'))));

create policy member_read on public.role_permissions for select to authenticated using (public.is_member(event_id));
create policy manage on public.role_permissions for insert to authenticated with check (public.has_perm(event_id, 'permissions.manage'));
create policy manage_del on public.role_permissions for delete to authenticated using (public.has_perm(event_id, 'permissions.manage'));

create policy read_own_or_manage on public.event_memberships for select to authenticated using (
  user_id = auth.uid() or public.has_perm(event_id, 'staff.manage') or public.has_perm(event_id, 'shift.assign')
  or public.has_perm(event_id, 'permissions.manage'));
-- event_admin role can only be granted by someone holding permissions.manage
create policy manage on public.event_memberships for insert to authenticated with check (
  public.has_perm(event_id, 'staff.manage') and (role_code <> 'event_admin' or public.has_perm(event_id, 'permissions.manage')));
create policy manage_upd on public.event_memberships for update to authenticated
  using (public.has_perm(event_id, 'staff.manage'))
  with check (public.has_perm(event_id, 'staff.manage') and user_id <> auth.uid());

create policy read on public.member_permission_overrides for select to authenticated using (
  user_id = auth.uid() or public.has_perm(event_id, 'permissions.manage'));
create policy manage_ins on public.member_permission_overrides for insert to authenticated with check (public.has_perm(event_id, 'permissions.manage'));
create policy manage_upd on public.member_permission_overrides for update to authenticated using (public.has_perm(event_id, 'permissions.manage'));
create policy manage_del on public.member_permission_overrides for delete to authenticated using (public.has_perm(event_id, 'permissions.manage'));

create policy audit_read on public.audit_logs for select to authenticated using (public.has_perm(event_id, 'audit.view'));

-- ---------------------------------------------------------------- policies: configuration
create policy member_read on public.test_catalog for select to authenticated using (public.is_member(event_id));
create policy edit_ins on public.test_catalog for insert to authenticated with check (public.has_perm(event_id, 'catalogue.edit'));
create policy edit_upd on public.test_catalog for update to authenticated
  using (public.has_perm(event_id, 'catalogue.edit')) with check (public.has_perm(event_id, 'catalogue.edit'));

create policy member_read on public.packages for select to authenticated using (public.is_member(event_id));
create policy edit_upd on public.packages for update to authenticated
  using (public.has_perm(event_id, 'package.edit')) with check (public.has_perm(event_id, 'package.edit'));

create policy member_read on public.workflow_services for select to authenticated using (public.is_member(event_id));
create policy edit_ins on public.workflow_services for insert to authenticated with check (public.has_perm(event_id, 'package.test_mapping.edit'));
create policy edit_upd on public.workflow_services for update to authenticated
  using (public.has_perm(event_id, 'package.test_mapping.edit')) with check (public.has_perm(event_id, 'package.test_mapping.edit'));

do $$
declare t text;
begin
  foreach t in array array['workflow_service_tests','choice_groups','package_tests'] loop
    execute format('create policy member_read on public.%I for select to authenticated using (public.is_member(event_id))', t);
    execute format('create policy edit_ins on public.%I for insert to authenticated with check (public.has_perm(event_id, ''package.test_mapping.edit''))', t);
    execute format('create policy edit_upd on public.%I for update to authenticated using (public.has_perm(event_id, ''package.test_mapping.edit'')) with check (public.has_perm(event_id, ''package.test_mapping.edit''))', t);
    execute format('create policy edit_del on public.%I for delete to authenticated using (public.has_perm(event_id, ''package.test_mapping.edit''))', t);
  end loop;
end $$;

create policy member_read on public.package_configuration_versions for select to authenticated using (public.is_member(event_id));

create policy member_read on public.addon_prices for select to authenticated using (public.is_member(event_id));
create policy edit_ins on public.addon_prices for insert to authenticated with check (public.has_perm(event_id, 'addon.price.edit'));
create policy edit_upd on public.addon_prices for update to authenticated
  using (public.has_perm(event_id, 'addon.price.edit')) with check (public.has_perm(event_id, 'addon.price.edit'));

create policy member_read on public.stations for select to authenticated using (public.is_member(event_id));
create policy edit_ins on public.stations for insert to authenticated with check (public.has_perm(event_id, 'station.configure'));
create policy edit_upd on public.stations for update to authenticated
  using (public.has_perm(event_id, 'station.configure')) with check (public.has_perm(event_id, 'station.configure'));

create policy member_read on public.station_capabilities for select to authenticated using (public.is_member(event_id));
create policy edit_ins on public.station_capabilities for insert to authenticated with check (public.has_perm(event_id, 'station.mapping.edit'));
create policy edit_del on public.station_capabilities for delete to authenticated using (public.has_perm(event_id, 'station.mapping.edit'));

create policy member_read on public.station_events for select to authenticated using (public.is_member(event_id));
create policy member_read on public.staff_assignments for select to authenticated using (public.is_member(event_id));

-- ---------------------------------------------------------------- policies: operations
do $$
declare t text;
begin
  foreach t in array array['participants','registrations','orders','order_items','participant_tasks','queue_assignments',
                           'task_status_history','task_attendance_events','walkin_visits','scan_events'] loop
    execute format('create policy participant_view on public.%I for select to authenticated using (public.has_perm(event_id, ''participant.view''))', t);
  end loop;
  foreach t in array array['payment_intents','payment_transactions','refunds','receipts'] loop
    execute format('create policy payment_view on public.%I for select to authenticated using (public.has_perm(event_id, ''payment.view'') or public.has_perm(event_id, ''finance.view''))', t);
  end loop;
  foreach t in array array['reports','report_import_jobs'] loop
    execute format('create policy report_view on public.%I for select to authenticated using (public.has_perm(event_id, ''report.view''))', t);
  end loop;
end $$;

create policy participant_view on public.task_items for select to authenticated using (
  exists (select 1 from public.participant_tasks t where t.id = task_id));
create policy participant_view on public.tag_prints for select to authenticated using (
  exists (select 1 from public.registrations r where r.id = registration_id));
-- sponsor_backend_rates, registration_tokens, portal_otps, portal_sessions, package_code_counters: no policies

-- ---------------------------------------------------------------- realtime (notifications only; DB is authoritative)
alter publication supabase_realtime add table public.queue_assignments, public.participant_tasks, public.stations,
  public.registrations, public.payment_intents, public.reports;

-- ---------------------------------------------------------------- private report storage
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('reports', 'reports', false, 15728640, array['application/pdf','image/png','image/jpeg'])
on conflict (id) do update set public = false;
-- no storage.objects policies: only the server (service role) reads/writes, after RPC authorisation
