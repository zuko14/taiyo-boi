-- Event lifecycle (pilot reset, owner delete), catalogue/package deletion and custom package
-- events (any number of packages with a backend package rate) alongside the fixed Female/Male
-- Bank of India mode.
--
-- package_mode (events.settings.package_mode):
--   'female_male' — exactly the two client packages; set by apply_brochure_template.
--   'custom'      — admin-defined packages (default for events created without the template).

-- ---------------------------------------------------------------- purge guard
-- Append-only tables may be emptied only inside the purge functions below, which set a
-- transaction-local flag. Clients cannot set GUCs through PostgREST.
create or replace function public.forbid_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('app.purge', true) = 'on' then return old; end if;
  raise exception 'append_only: % rows cannot be modified or deleted', tg_table_name;
end $$;

-- While an event row is being deleted, cascaded config deletes must not write audit rows for it.
create or replace function public.config_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_event uuid := case when tg_table_name = 'events' then (v_row->>'id')::uuid else (v_row->>'event_id')::uuid end;
  v_status text;
  v_reason text := public.request_reason();
begin
  if current_setting('app.purging_event', true) = v_event::text then return coalesce(new, old); end if;
  if tg_table_name = 'events' then
    v_status := to_jsonb(old)->>'status';   -- guard applies if the event WAS live
  else
    select status into v_status from events where id = v_event;
  end if;
  if auth.uid() is not null and v_status in ('live','paused') and v_reason is null then
    raise exception 'reason_required: changing configuration of a live event requires a reason'
      using errcode = 'P0001';
  end if;
  if tg_table_name <> 'events' then
    update events set config_version = config_version + 1 where id = v_event;
  end if;
  insert into audit_logs (event_id, actor_id, action, entity_type, entity_id, reason, meta, request_id)
  values (v_event, auth.uid(), lower(tg_op), tg_table_name,
          coalesce(v_row->>'id', v_row->>'test_id', v_row->>'station_id'),
          v_reason,
          jsonb_build_object('before', case when tg_op <> 'INSERT' then to_jsonb(old) end,
                             'after', case when tg_op <> 'DELETE' then to_jsonb(new) end),
          public.request_header('x-request-id'));
  return coalesce(new, old);
end $$;

-- ---------------------------------------------------------------- permission
insert into public.permissions (code, description) values
  ('event.reset', 'Reset a pilot/test event: delete all participants, orders, queues and reports')
on conflict (code) do nothing;
insert into public.default_role_permissions (role_code, permission_code) values ('event_admin', 'event.reset')
on conflict do nothing;
insert into public.role_permissions (event_id, role_code, permission_code)
select id, 'event_admin', 'event.reset' from public.events
on conflict do nothing;

-- ---------------------------------------------------------------- operational purge
-- Deletes everything a participant journey creates. Configuration, staff and audit stay.
-- Returns report storage keys so the server can remove the private files.
create or replace function public._purge_operational(p_event uuid) returns text[]
language plpgsql security definer set search_path = public as $$
declare v_keys text[];
begin
  perform set_config('app.purge', 'on', true);
  select coalesce(array_agg(storage_key), '{}') into v_keys from reports where event_id = p_event;
  delete from portal_sessions where registration_id in (select id from registrations where event_id = p_event);
  delete from portal_otps where registration_id in (select id from registrations where event_id = p_event);
  delete from report_import_jobs where event_id = p_event;
  delete from reports where event_id = p_event;
  delete from scan_events where event_id = p_event;
  delete from task_attendance_events where event_id = p_event;
  delete from task_status_history where event_id = p_event;
  delete from queue_assignments where event_id = p_event;
  delete from task_items where task_id in (select id from participant_tasks where event_id = p_event);
  delete from participant_tasks where event_id = p_event;
  delete from walkin_visits where event_id = p_event;
  delete from receipts where event_id = p_event;
  delete from refunds where event_id = p_event;
  delete from payment_transactions where event_id = p_event;
  delete from payment_intents where event_id = p_event;
  delete from order_items where event_id = p_event;
  delete from orders where event_id = p_event;
  delete from tag_prints where registration_id in (select id from registrations where event_id = p_event);
  delete from registration_tokens where registration_id in (select id from registrations where event_id = p_event);
  delete from registrations where event_id = p_event;
  delete from participants where event_id = p_event;
  delete from package_code_counters where event_id = p_event;
  delete from staff_assignments where event_id = p_event;
  delete from station_events where event_id = p_event;
  return v_keys;
end $$;

create or replace function public.reset_event(p_event uuid, p_confirm_code text, p_reason text) returns text[]
language plpgsql security definer set search_path = public as $$
declare e events; v_regs int; v_keys text[];
begin
  perform public._lock_event(p_event);
  if not (public.is_platform_admin() or public.has_perm(p_event, 'event.reset')) then
    raise exception 'permission_denied: event.reset' using errcode = '42501';
  end if;
  select * into e from events where id = p_event for update;
  if e.id is null then raise exception 'not_found: event'; end if;
  if upper(btrim(coalesce(p_confirm_code, ''))) <> e.code then
    raise exception 'confirm_mismatch: type the event code % to confirm', e.code;
  end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required: reset reason'; end if;
  perform set_config('app.reason', p_reason, true);
  select count(*) into v_regs from registrations where event_id = p_event;
  v_keys := public._purge_operational(p_event);
  update stations set status = 'closed', pause_reason = null, next_seq = 1, last_assigned_at = null
   where event_id = p_event;
  update events set status = 'draft', receipt_seq = 0 where id = p_event;
  perform public.write_audit(p_event, 'event.reset', 'event', p_event::text, p_reason,
    jsonb_build_object('registrations_removed', v_regs, 'from_status', e.status, 'report_files', coalesce(array_length(v_keys, 1), 0)));
  return v_keys;
end $$;

create or replace function public.delete_event(p_event uuid, p_confirm_code text) returns text[]
language plpgsql security definer set search_path = public as $$
declare e events; v_keys text[];
begin
  perform public._lock_event(p_event);
  if not public.is_platform_admin() then raise exception 'permission_denied: platform admin' using errcode = '42501'; end if;
  select * into e from events where id = p_event for update;
  if e.id is null then raise exception 'not_found: event'; end if;
  if upper(btrim(coalesce(p_confirm_code, ''))) <> e.code then
    raise exception 'confirm_mismatch: type the event code % to confirm', e.code;
  end if;
  if e.status = 'live' then raise exception 'event_live: pause or close the event before deleting it'; end if;
  v_keys := public._purge_operational(p_event);
  perform set_config('app.purging_event', p_event::text, true);
  -- explicit order: cascades are checked table by table, so dependants must go first
  delete from package_configuration_versions where event_id = p_event;
  delete from package_tests where event_id = p_event;
  delete from choice_groups where event_id = p_event;
  delete from packages where event_id = p_event;
  delete from sponsor_backend_rates where event_id = p_event;
  delete from addon_prices where event_id = p_event;
  delete from workflow_service_tests where event_id = p_event;
  delete from station_capabilities where event_id = p_event;
  delete from stations where event_id = p_event;
  delete from workflow_services where event_id = p_event;
  delete from test_catalog where event_id = p_event;
  delete from member_permission_overrides where event_id = p_event;
  delete from event_memberships where event_id = p_event;
  delete from role_permissions where event_id = p_event;
  delete from audit_logs where event_id = p_event;
  delete from events where id = p_event;
  perform public.write_audit(null, 'event.delete', 'event', p_event::text, null,
    jsonb_build_object('code', e.code, 'name', e.name, 'status', e.status));
  return v_keys;
end $$;

-- ---------------------------------------------------------------- catalogue delete
-- Hard delete only while no participant order references the test; otherwise archive it.
create or replace function public.delete_test(p_test uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare t test_catalog;
begin
  select * into t from test_catalog where id = p_test;
  if t.id is null then raise exception 'not_found: test'; end if;
  perform public.require_perm(t.event_id, 'catalogue.edit');
  if exists (select 1 from order_items where test_id = p_test) then
    raise exception 'in_use: participants already have orders for this test — archive it instead';
  end if;
  perform set_config('app.reason', coalesce(p_reason, ''), true);
  delete from package_tests where test_id = p_test;
  delete from addon_prices where test_id = p_test;
  delete from test_catalog where id = p_test;      -- workflow_service_tests cascade
end $$;

-- ---------------------------------------------------------------- custom packages
alter table public.packages drop constraint if exists packages_classification_check;
alter table public.packages add constraint packages_classification_check check (classification ~ '^[a-z0-9_]{1,30}$');
alter table public.registrations drop constraint if exists registrations_classification_check;
alter table public.registrations add constraint registrations_classification_check check (classification ~ '^[a-z0-9_]{1,30}$');
alter table public.package_code_counters drop constraint if exists package_code_counters_classification_check;
alter table public.package_code_counters add constraint package_code_counters_classification_check check (classification ~ '^[a-z0-9_]{1,30}$');
alter table public.sponsor_backend_rates drop constraint if exists sponsor_backend_rates_classification_check;
alter table public.sponsor_backend_rates add constraint sponsor_backend_rates_classification_check check (classification ~ '^[a-z0-9_]{1,30}$');
-- custom events only: what the participant pays for the package (null/0 = free). Never set for
-- the fixed Female/Male packages, whose sponsor rates stay in sponsor_backend_rates.
alter table public.packages add column price_paise bigint check (price_paise is null or price_paise >= 0);
-- two packages sharing a code letter would issue colliding registration codes
create unique index if not exists packages_event_code_letter on public.packages (event_id, code_letter);

update public.events e set settings = e.settings || jsonb_build_object('package_mode',
  case when exists (select 1 from packages p where p.event_id = e.id and p.classification in ('female','male'))
       then 'female_male' else 'custom' end)
 where not (e.settings ? 'package_mode');

create or replace function public.package_mode(p_event uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(settings->>'package_mode', 'custom') from events where id = p_event
$$;

create or replace function public.packages_mode_guard() returns trigger
language plpgsql as $$
begin
  if public.package_mode(new.event_id) = 'female_male'
     and (new.classification not in ('female','male') or new.price_paise is not null) then
    raise exception 'package_mode: this event uses the fixed, sponsor-funded Female/Male packages';
  end if;
  return new;
end $$;
create trigger packages_mode_guard before insert or update of classification, price_paise on public.packages
  for each row execute function public.packages_mode_guard();

create or replace function public.create_package(p_event uuid, p_code text, p_name text, p_code_letter text,
  p_description text default '') returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_code text := upper(btrim(p_code));
begin
  perform public.require_perm(p_event, 'package.edit');
  if public.package_mode(p_event) <> 'custom' then
    raise exception 'package_mode: this event uses the fixed Female/Male packages';
  end if;
  if v_code !~ '^[A-Z0-9_]{1,30}$' then raise exception 'invalid_code: package code may use A–Z, 0–9 and _ (max 30)'; end if;
  insert into packages (event_id, classification, code, name, code_letter, description)
  values (p_event, lower(v_code), v_code, btrim(p_name), upper(btrim(p_code_letter)), coalesce(p_description, ''))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.delete_package(p_package uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare pk packages;
begin
  select * into pk from packages where id = p_package;
  if pk.id is null then raise exception 'not_found: package'; end if;
  perform public.require_perm(pk.event_id, 'package.edit');
  if public.package_mode(pk.event_id) <> 'custom' then
    raise exception 'package_mode: the fixed Female/Male packages cannot be deleted';
  end if;
  if exists (select 1 from registrations where package_id = p_package) then
    raise exception 'in_use: participants are registered on this package — deactivate it instead';
  end if;
  perform set_config('app.reason', coalesce(p_reason, ''), true);
  perform set_config('app.purge', 'on', true);       -- unused config snapshots of this package
  delete from package_configuration_versions where package_id = p_package;
  delete from sponsor_backend_rates where event_id = pk.event_id and classification = pk.classification;
  delete from package_tests where package_id = p_package;
  delete from choice_groups where package_id = p_package;
  delete from packages where id = p_package;
end $$;

-- Participant price of a custom-event package. The Bank of India brochure rates stay backend-only
-- (CLAUDE.md §5.2) and are never touched here.
create or replace function public.set_package_rate(p_package uuid, p_amount_paise bigint, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare pk packages;
begin
  select * into pk from packages where id = p_package;
  if pk.id is null then raise exception 'not_found: package'; end if;
  perform public.require_perm(pk.event_id, 'package.edit');
  if public.package_mode(pk.event_id) <> 'custom' then raise exception 'package_mode: rate is backend-only for this event'; end if;
  if p_amount_paise < 0 then raise exception 'invalid_amount'; end if;
  if p_reason is not null then perform set_config('app.reason', p_reason, true); end if;
  -- existing registrations keep the amount on their own package order / payment
  update packages set price_paise = nullif(p_amount_paise, 0) where id = pk.id;
  perform public.write_audit(pk.event_id, 'package.rate', 'package', pk.id::text, null,
    jsonb_build_object('amount_paise', p_amount_paise));
end $$;

create or replace function public.package_rates(p_event uuid)
returns table (package_id uuid, amount_paise bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_perm(p_event, 'package.edit');
  if public.package_mode(p_event) <> 'custom' then return; end if;
  return query select p.id, p.price_paise from packages p where p.event_id = p_event and p.price_paise is not null;
end $$;

-- ---------------------------------------------------------------- registration: any configured package
create or replace function public.register_participant(
  p_counter uuid, p_idempotency_key text, p_classification text, p_full_name text,
  p_age int default null, p_employee_id text default null, p_mobile text default null,
  p_email text default null, p_department text default null, p_consent boolean default false,
  p_package_override uuid default null, p_override_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s stations; e events; pkg packages; r registrations;
  v_participant uuid; v_seq int; v_code text; v_version uuid; v_snapshot jsonb; v_assign uuid;
begin
  perform public._lock_event((select event_id from stations where id = p_counter));
  s := public.assert_on_duty(p_counter, array['registration_counter']);
  perform public.require_perm(s.event_id, 'registration.create');
  perform public.assert_event_live(s.event_id);
  select * into e from events where id = s.event_id;

  if coalesce(btrim(p_idempotency_key), '') = '' then raise exception 'idempotency_key_required'; end if;
  select * into r from registrations where event_id = e.id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('registration_id', r.id, 'registration_code', r.registration_code, 'already', true);
  end if;

  if not exists (select 1 from packages where event_id = e.id and classification = coalesce(p_classification, '')) then
    raise exception 'invalid_classification: choose one of the configured packages';
  end if;
  if coalesce((e.settings->>'require_consent')::boolean, true) and not coalesce(p_consent, false) then
    raise exception 'consent_required: participant consent/privacy acknowledgement is required';
  end if;
  if e.registration_opens_at is not null and now() < e.registration_opens_at
     or e.registration_closes_at is not null and now() > e.registration_closes_at then
    raise exception 'registration_closed';
  end if;

  if p_package_override is not null then
    perform public.require_perm(e.id, 'registration.classification_override');
    if coalesce(btrim(p_override_reason), '') = '' then raise exception 'reason_required: override reason'; end if;
    select * into pkg from packages where id = p_package_override and event_id = e.id and active;
  else
    select * into pkg from packages where event_id = e.id and classification = p_classification and active;
  end if;
  if pkg.id is null then raise exception 'config_invalid: no active package for %', p_classification; end if;
  if p_package_override is null and pkg.classification <> p_classification then
    raise exception 'package_mismatch';
  end if;

  insert into participants (event_id, full_name, age, employee_id, mobile, email, department, consent_at)
  values (e.id, btrim(p_full_name), p_age, nullif(btrim(p_employee_id), ''), nullif(btrim(p_mobile), ''),
          nullif(btrim(p_email), ''), nullif(btrim(p_department), ''), case when p_consent then now() end)
  returning id into v_participant;

  -- package-specific counter; the row lock serialises parallel counters
  insert into package_code_counters (event_id, classification, next_seq) values (e.id, pkg.classification, 2)
  on conflict (event_id, classification) do update set next_seq = package_code_counters.next_seq + 1
  returning next_seq - 1 into v_seq;
  v_code := replace(replace(replace(replace(e.code_format,
              '{PREFIX}', e.code_prefix), '{CLS}', pkg.code_letter), '{YEAR}', e.code_year::text),
              '{SEQ}', lpad(v_seq::text, e.code_seq_digits, '0'));

  v_version := public._package_version(pkg.id);
  select snapshot into v_snapshot from package_configuration_versions where id = v_version;
  if jsonb_array_length(v_snapshot->'tests') = 0 then raise exception 'config_invalid: package has no tests'; end if;

  insert into registrations (event_id, participant_id, registration_code, classification, package_id,
                             package_version_id, counter_station_id, classification_override_reason,
                             idempotency_key, created_by)
  values (e.id, v_participant, v_code, p_classification, pkg.id, v_version, s.id,
          case when p_package_override is not null then p_override_reason end,
          p_idempotency_key, auth.uid())
  returning * into r;

  perform public._materialize_package(r.id, v_snapshot);
  perform public.write_audit(e.id, 'registration.create', 'registration', r.id::text, p_override_reason,
    jsonb_build_object('code', v_code, 'package', pkg.code, 'counter', s.code,
                       'override', p_package_override is not null));
  v_assign := public._schedule_next(r.id);
  return jsonb_build_object('registration_id', r.id, 'registration_code', v_code, 'already', false,
                            'assignment_id', v_assign);
end $$;

-- ---------------------------------------------------------------- readiness: mode-aware package check
do $$
declare d text;
begin
  d := pg_get_functiondef('public.validate_event(uuid)'::regprocedure);
  d := replace(d,
    $old$select 'error', 'Missing ' || c || ' package' from unnest(array['female','male']) c
     where not exists (select 1 from packages p where p.event_id = p_event and p.classification = c and p.active)$old$,
    $new$select 'error', 'Missing ' || c || ' package' from unnest(array['female','male']) c
     where coalesce(e.settings->>'package_mode', 'custom') = 'female_male'
       and not exists (select 1 from packages p where p.event_id = p_event and p.classification = c and p.active)
    union all
    select 'error', 'No active package configured'
     where coalesce(e.settings->>'package_mode', 'custom') = 'custom'
       and not exists (select 1 from packages p where p.event_id = p_event and p.active)$new$);
  if position('No active package configured' in d) = 0 then raise exception 'validate_event patch did not apply'; end if;
  execute d;

  d := pg_get_functiondef('public.sponsor_summary(uuid)'::regprocedure);
  d := replace(d, $old$from unnest(array['female','male']) c);$old$,
    $new$from (select classification as c from packages where event_id = p_event) pc);$new$);
  if position('from packages where event_id = p_event) pc' in d) = 0 then raise exception 'sponsor_summary patch did not apply'; end if;
  execute d;

  d := pg_get_functiondef('public.apply_brochure_template(uuid)'::regprocedure);
  d := replace(d, $old$'{"grouping_approved": false}'::jsonb$old$, $new$'{"grouping_approved": false, "package_mode": "female_male"}'::jsonb$new$);
  if position('"package_mode": "female_male"' in d) = 0 then raise exception 'apply_brochure_template patch did not apply'; end if;
  execute d;

  -- registrations per package (custom events have no Female/Male split)
  d := pg_get_functiondef('public.dashboard_overview(uuid)'::regprocedure);
  d := replace(d, $old$    'by_counter', coalesce($old$,
    $new$    'by_package', coalesce((select jsonb_agg(x order by x->>'name') from (
        select jsonb_build_object('name', p.name, 'classification', p.classification, 'count', count(r.id)) x
          from packages p left join registrations r on r.package_id = p.id and r.status = 'active'
         where p.event_id = p_event group by p.id, p.name, p.classification) q), '[]'),
    'by_counter', coalesce($new$);
  if position('''by_package''' in d) = 0 then raise exception 'dashboard_overview patch did not apply'; end if;
  execute d;
end $$;

-- new functions get Supabase's default PUBLIC/anon execute; lock them down first
revoke execute on function
  public._purge_operational(uuid), public.packages_mode_guard(),
  public.reset_event(uuid, text, text), public.delete_event(uuid, text), public.delete_test(uuid, text),
  public.package_mode(uuid), public.create_package(uuid, text, text, text, text), public.delete_package(uuid, text),
  public.set_package_rate(uuid, bigint, text), public.package_rates(uuid)
from public, anon, authenticated;
grant execute on function
  public.reset_event(uuid, text, text), public.delete_event(uuid, text), public.delete_test(uuid, text),
  public.package_mode(uuid), public.create_package(uuid, text, text, text, text), public.delete_package(uuid, text),
  public.set_package_rate(uuid, bigint, text), public.package_rates(uuid)
to authenticated;
