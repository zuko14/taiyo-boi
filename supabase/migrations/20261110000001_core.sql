-- Core: events, staff, RBAC, audit.
-- Money is stored as integer paise. All consequential state changes go through
-- SECURITY DEFINER functions (see later migrations) that check has_perm().

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- events
create table public.events (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9-]{2,30}$'),
  name text not null,
  sponsor_name text not null default 'Bank of India',
  lab_partner_name text not null default '',          -- confirm before launch (CLAUDE.md §1)
  venue text not null default '',
  help_contact text not null default '',
  portal_instructions text not null default '',
  timezone text not null default 'Asia/Kolkata',
  starts_at timestamptz,
  ends_at timestamptz,
  registration_opens_at timestamptz,
  registration_closes_at timestamptz,
  expected_attendance int not null default 500 check (expected_attendance >= 0),
  status text not null default 'draft'
    check (status in ('draft','ready','live','paused','closed','archived')),
  code_prefix text not null default 'BOI' check (code_prefix ~ '^[A-Z0-9]{1,8}$'),
  code_year int not null default extract(year from now())::int,
  code_format text not null default '{PREFIX}-{CLS}-{YEAR}-{SEQ}',
  code_seq_digits int not null default 6 check (code_seq_digits between 3 and 9),
  receipt_seq int not null default 0,
  config_version int not null default 1,
  settings jsonb not null default '{
    "require_consent": true,
    "payment_maker_checker": true,
    "report_maker_checker": true,
    "payment_methods": [],
    "portal_otp_required": true,
    "default_service_minutes": 5
  }'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- staff & RBAC
create table public.staff_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null,
  is_platform_admin boolean not null default false,
  mfa_required boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.permissions (
  code text primary key,
  description text not null
);

create table public.roles (
  code text primary key,
  name text not null,
  description text not null default ''
);

-- template copied into role_permissions when an event is created
create table public.default_role_permissions (
  role_code text not null references public.roles(code),
  permission_code text not null references public.permissions(code),
  primary key (role_code, permission_code)
);

create table public.role_permissions (
  event_id uuid not null references public.events(id) on delete cascade,
  role_code text not null references public.roles(code),
  permission_code text not null references public.permissions(code),
  primary key (event_id, role_code, permission_code)
);

create table public.event_memberships (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.staff_profiles(user_id),
  role_code text not null references public.roles(code),
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (event_id, user_id, role_code)
);
create index on public.event_memberships (user_id) where active;

-- individual grant (granted=true) or revoke (granted=false) on top of roles
create table public.member_permission_overrides (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.staff_profiles(user_id),
  permission_code text not null references public.permissions(code),
  granted boolean not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id, permission_code)
);

-- ---------------------------------------------------------------- audit
create table public.audit_logs (
  id bigint generated always as identity primary key,
  event_id uuid references public.events(id),
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id text,
  reason text,
  meta jsonb not null default '{}'::jsonb,
  request_id text,
  created_at timestamptz not null default now()
);
create index on public.audit_logs (event_id, created_at desc);
create index on public.audit_logs (entity_type, entity_id);

create or replace function public.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'append_only: % rows cannot be modified or deleted', tg_table_name;
end $$;

create trigger audit_logs_append_only before update or delete on public.audit_logs
  for each row execute function public.forbid_mutation();

-- ---------------------------------------------------------------- helpers
create or replace function public.request_header(p_name text) returns text
language sql stable as $$
  select nullif(current_setting('request.headers', true), '')::json ->> p_name
$$;

-- Reason passed by the app as base64 header (headers cannot carry arbitrary UTF-8).
create or replace function public.request_reason() returns text
language plpgsql stable as $$
declare v text := public.request_header('x-audit-reason');
begin
  -- RPCs set app.reason (transaction-local) from their p_reason argument
  if nullif(btrim(current_setting('app.reason', true)), '') is not null then
    return btrim(current_setting('app.reason', true));
  end if;
  if v is null or v = '' then return null; end if;
  return nullif(btrim(convert_from(decode(v, 'base64'), 'utf8')), '');
exception when others then
  return null;
end $$;

create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_platform_admin from staff_profiles where user_id = auth.uid()), false)
$$;

create or replace function public.is_member(p_event uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_platform_admin() or exists (
    select 1 from event_memberships m
    where m.event_id = p_event and m.user_id = auth.uid() and m.active)
$$;

create or replace function public.has_perm(p_event uuid, p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_platform_admin() or (
    exists (select 1 from event_memberships m
            where m.event_id = p_event and m.user_id = auth.uid() and m.active)
    and not exists (select 1 from member_permission_overrides o
                    where o.event_id = p_event and o.user_id = auth.uid()
                      and o.permission_code = p_perm and not o.granted)
    and (
      exists (select 1 from event_memberships m
              join role_permissions rp on rp.event_id = m.event_id and rp.role_code = m.role_code
              where m.event_id = p_event and m.user_id = auth.uid() and m.active
                and rp.permission_code = p_perm)
      or exists (select 1 from member_permission_overrides o
                 where o.event_id = p_event and o.user_id = auth.uid()
                   and o.permission_code = p_perm and o.granted)))
$$;

create or replace function public.require_perm(p_event uuid, p_perm text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.has_perm(p_event, p_perm) then
    raise exception 'permission_denied: %', p_perm using errcode = '42501';
  end if;
end $$;

create or replace function public.my_permissions(p_event uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(code order by code), '{}') from permissions where public.has_perm(p_event, code)
$$;

create or replace function public.write_audit(
  p_event uuid, p_action text, p_entity text, p_entity_id text,
  p_reason text default null, p_meta jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into audit_logs (event_id, actor_id, action, entity_type, entity_id, reason, meta, request_id)
  values (p_event, auth.uid(), p_action, p_entity, p_entity_id,
          coalesce(p_reason, public.request_reason()), coalesce(p_meta, '{}'::jsonb),
          public.request_header('x-request-id'))
$$;

create or replace function public.event_setting(p_event uuid, p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  select settings -> p_key from events where id = p_event
$$;

-- Generic audit + live-config guard for admin-editable configuration tables.
-- Every such table carries event_id. Changes on a live/paused event need a reason
-- (header x-audit-reason) and bump events.config_version.
create or replace function public.config_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_event uuid := case when tg_table_name = 'events' then (v_row->>'id')::uuid else (v_row->>'event_id')::uuid end;
  v_status text;
  v_reason text := public.request_reason();
begin
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

create trigger events_audit after update on public.events
  for each row when (old.* is distinct from new.*
    and old.config_version = new.config_version and old.receipt_seq = new.receipt_seq)
  execute function public.config_audit();
create trigger role_permissions_audit after insert or update or delete on public.role_permissions
  for each row execute function public.config_audit();
create trigger memberships_audit after insert or update or delete on public.event_memberships
  for each row execute function public.config_audit();
create trigger overrides_audit after insert or update or delete on public.member_permission_overrides
  for each row execute function public.config_audit();

-- ---------------------------------------------------------------- permission catalogue
insert into public.permissions (code, description) values
 ('event.configure','Edit event profile, settings and status'),
 ('dashboard.view','View the operational dashboard'),
 ('catalogue.view','View the test catalogue'),
 ('catalogue.edit','Create/edit test catalogue entries'),
 ('package.view','View package definitions'),
 ('package.edit','Edit package names, descriptions and status'),
 ('package.test_mapping.edit','Edit package tests, choice groups and workflow service grouping'),
 ('addon.price.edit','Edit add-on prices'),
 ('station.configure','Create/edit counters, stations and walk-in centres'),
 ('station.mapping.edit','Edit which services a station can perform'),
 ('station.operate','Open, pause or close stations'),
 ('live_configuration.override','Migrate existing registrations to current configuration'),
 ('staff.manage','Create staff accounts, memberships and shift assignments'),
 ('permissions.manage','Edit role permissions and individual grants'),
 ('shift.override','Act without an active counter/station shift'),
 ('shift.assign','Assign staff to counters/stations and end shifts'),
 ('participant.view','View participant identity details'),
 ('registration.create','Register participants'),
 ('registration.correct','Correct registration details'),
 ('registration.classification_override','Override Female/Male package mapping'),
 ('registration.duplicate_resolve','Resolve duplicate registrations'),
 ('tag.reprint','Reprint tags (rotates the portal token)'),
 ('tag.revoke','Revoke a lost tag'),
 ('choice.select','Record a participant''s choice-group selection'),
 ('addon.create','Create add-on orders'),
 ('payment.view','View payment records'),
 ('payment.verify','Verify payments and issue receipts'),
 ('payment.refund','Refund or cancel paid add-ons'),
 ('payment.waive','Waive an add-on payment'),
 ('payment.exception','Allow an unpaid add-on task to be performed'),
 ('queue.view','View station queues'),
 ('queue.override','Reassign, requeue and resolve queue exceptions'),
 ('task.perform','Call, start, complete tasks at an assigned station'),
 ('task.skip','Skip or cancel tasks'),
 ('walkin.checkin','Check participants in at a walk-in centre'),
 ('walkin.perform','Start/complete walk-in tasks'),
 ('report.view','View report records'),
 ('report.upload','Upload reports'),
 ('report.validate','Validate reports and resolve review items'),
 ('report.publish','Publish reports to participants'),
 ('report.withdraw','Withdraw reports'),
 ('finance.view','View add-on revenue and payment reconciliation'),
 ('sponsor.view','View sponsor attendance counts (no money values)'),
 ('audit.view','View the audit log'),
 ('export.run','Run operational exports');

insert into public.roles (code, name, description) values
 ('event_admin','Event Admin','Full event configuration and operations'),
 ('registration_supervisor','Registration Supervisor','Supervises registration counters'),
 ('registration_staff','Registration Staff','Registers participants and prints tags'),
 ('addon_staff','Add-on Desk Staff','Creates add-on orders'),
 ('cashier','Payment Verifier / Cashier','Verifies payments and issues receipts'),
 ('station_supervisor','Station Supervisor','Manages stations and queues'),
 ('station_staff','Station Technician','Performs tasks at a station'),
 ('walkin_staff','Walk-in Centre Staff','Handles walk-in centre visits'),
 ('report_manager','Report Manager / Lab Staff','Uploads, validates and publishes reports'),
 ('finance_viewer','Finance / Audit Viewer','Read-only finance and audit'),
 ('sponsor_viewer','Sponsor Viewer','Read-only sponsor attendance counts');

insert into public.default_role_permissions (role_code, permission_code)
select 'event_admin', code from public.permissions
union all select 'registration_supervisor', p from unnest(array[
  'dashboard.view','participant.view','registration.create','registration.correct',
  'registration.classification_override','registration.duplicate_resolve','tag.reprint','tag.revoke',
  'choice.select','queue.view','catalogue.view','package.view','export.run','shift.assign']) p
union all select 'registration_staff', p from unnest(array[
  'participant.view','registration.create','choice.select','catalogue.view','package.view']) p
union all select 'addon_staff', p from unnest(array[
  'participant.view','addon.create','payment.view','catalogue.view','package.view']) p
union all select 'cashier', p from unnest(array[
  'participant.view','payment.view','payment.verify','catalogue.view']) p
union all select 'station_supervisor', p from unnest(array[
  'dashboard.view','participant.view','station.operate','queue.view','queue.override','task.perform',
  'task.skip','payment.exception','catalogue.view','package.view','shift.assign']) p
union all select 'station_staff', p from unnest(array[
  'participant.view','queue.view','task.perform']) p
union all select 'walkin_staff', p from unnest(array[
  'participant.view','walkin.checkin','walkin.perform','choice.select','queue.view']) p
union all select 'report_manager', p from unnest(array[
  'participant.view','report.view','report.upload','report.validate','report.publish','report.withdraw']) p
union all select 'finance_viewer', p from unnest(array[
  'finance.view','payment.view','sponsor.view','audit.view','dashboard.view','export.run']) p
union all select 'sponsor_viewer', p from unnest(array['sponsor.view']) p;
