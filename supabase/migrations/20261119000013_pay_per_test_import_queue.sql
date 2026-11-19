-- 1. Pay-per-test camps: the registration desk sells the event's priced tests in the same
--    transaction as the registration (one order, one payment, queued only after verification).
--    A patient may register for tests only, on an automatic "Pay per test" package.
-- 2. Atomic CSV catalogue import (tests, category, service mapping, MRP price).
-- 3. Queue: waiting participants are re-checked whenever a staffed station becomes available,
--    including shifts whose start time arrives later (nothing else fires at that moment).

-- ---------------------------------------------------------------- 1. tests sold at the counter
do $$
declare d text;
begin
  d := pg_get_functiondef('public.create_addon_order(uuid,uuid,uuid[],text,boolean)'::regprocedure);
  d := replace(d, $old$  s := public.assert_on_duty(p_desk, array['addon_desk']);$old$,
                  $new$  s := public.assert_on_duty(p_desk, array['addon_desk','registration_counter']);$new$);
  d := replace(d, $old$  perform public.require_perm(r.event_id, 'addon.create');$old$,
    $new$  -- a registration counter may sell the event's tests while registering (pay-per-test camps)
  perform public.require_perm(r.event_id, case when s.kind = 'registration_counter' then 'registration.create' else 'addon.create' end);$new$);
  if position($x$array['addon_desk','registration_counter']$x$ in d) = 0 or position('registration.create' in d) = 0 then
    raise exception 'create_addon_order patch did not apply';
  end if;
  execute d;

  -- the automatic tests-only package has no tests of its own by design
  d := pg_get_functiondef('public.validate_event(uuid)'::regprocedure);
  d := replace(d, $old$     where p.event_id = p_event and not exists (select 1 from package_tests pt where pt.package_id = p.id)$old$,
    $new$     where p.event_id = p_event and p.code <> 'PAY_PER_TEST'
       and not exists (select 1 from package_tests pt where pt.package_id = p.id)$new$);
  -- a pay-per-test camp may have no packages at all, as long as it sells priced tests
  d := replace(d, $old$    select 'error', 'No active package configured'$old$,
    $new$    select 'error', 'No active package or priced test configured'$new$);
  d := replace(d, $old$       and not exists (select 1 from packages p where p.event_id = p_event and p.active)$old$,
    $new$       and not exists (select 1 from packages p where p.event_id = p_event and p.active and p.code <> 'PAY_PER_TEST')
       and not exists (select 1 from test_catalog t join addon_prices ap on ap.test_id = t.id and ap.active
                        where t.event_id = p_event and t.active and not t.archived and t.addon_available)$new$);
  if position('PAY_PER_TEST' in d) = 0 or position('No active package or priced test configured' in d) = 0 then
    raise exception 'validate_event patch did not apply';
  end if;
  execute d;
end $$;

-- the event's tests-only package, created on first use; picks a free code letter
create or replace function public._pay_per_test_package(p_event uuid) returns packages
language plpgsql security definer set search_path = public as $$
declare pk packages; v_letter text; v_prev text := current_setting('app.reason', true);
begin
  select * into pk from packages where event_id = p_event and code = 'PAY_PER_TEST';
  if found then return pk; end if;
  -- system-created config on a live event still needs an audit reason; restore the caller's after
  perform set_config('app.reason', 'Automatic pay-per-test package (first tests-only registration)', true);
  select l into v_letter from unnest(string_to_array('T,W,Z,Y,X,V,U,S,R,Q,P,O,N,L,K,J,I,H,G,E,D,C,A', ',')) l
   where not exists (select 1 from packages where event_id = p_event and code_letter = l) limit 1;
  if v_letter is null then raise exception 'config_invalid: no free registration code letter for the pay-per-test package'; end if;
  insert into packages (event_id, classification, code, name, code_letter, description)
  values (p_event, 'pay_per_test', 'PAY_PER_TEST', 'Pay per test', v_letter, 'Tests chosen and paid at registration')
  returning * into pk;
  perform set_config('app.reason', coalesce(v_prev, ''), true);
  return pk;
end $$;

drop function public.register_participant(uuid, text, text, text, int, text, text, text, text, boolean, uuid, text);
create function public.register_participant(
  p_counter uuid, p_idempotency_key text, p_classification text, p_full_name text,
  p_age int default null, p_employee_id text default null, p_mobile text default null,
  p_email text default null, p_department text default null, p_consent boolean default false,
  p_package_override uuid default null, p_override_reason text default null,
  p_test_ids uuid[] default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s stations; e events; pkg packages; r registrations;
  v_participant uuid; v_seq int; v_code text; v_version uuid; v_snapshot jsonb; v_assign uuid;
  v_order uuid; v_intent uuid; v_tests jsonb;
  v_has_tests boolean := coalesce(array_length(p_test_ids, 1), 0) > 0;
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

  if v_has_tests and public.package_mode(e.id) <> 'custom' then
    raise exception 'package_mode: tests are sold at the add-on desk for this event';
  end if;
  if coalesce(p_classification, '') = '' and p_package_override is null then
    if not v_has_tests or public.package_mode(e.id) <> 'custom' then
      raise exception 'invalid_classification: choose a package or at least one test';
    end if;
    pkg := public._pay_per_test_package(e.id);
    p_classification := pkg.classification;
  elsif not exists (select 1 from packages where event_id = e.id and classification = p_classification) then
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
  if jsonb_array_length(v_snapshot->'tests') = 0 and not v_has_tests then
    raise exception 'config_invalid: package has no tests';
  end if;

  insert into registrations (event_id, participant_id, registration_code, classification, package_id,
                             package_version_id, counter_station_id, classification_override_reason,
                             idempotency_key, created_by)
  values (e.id, v_participant, v_code, p_classification, pkg.id, v_version, s.id,
          case when p_package_override is not null then p_override_reason end,
          p_idempotency_key, auth.uid())
  returning * into r;

  if coalesce(pkg.price_paise, 0) > 0 then
    insert into orders (event_id, registration_id, kind, total_paise, created_by)
    values (e.id, r.id, 'package', pkg.price_paise, auth.uid()) returning id into v_order;
    insert into payment_intents (event_id, order_id, registration_id, amount_paise, created_by)
    values (e.id, v_order, r.id, pkg.price_paise, auth.uid()) returning id into v_intent;
  end if;
  perform public._materialize_package(r.id, v_snapshot);
  -- desk-selected paid tests: same transaction, so a failure leaves no half registration
  if v_has_tests then
    v_tests := public.create_addon_order(r.id, s.id, p_test_ids, p_idempotency_key || ':tests', p_consent);
  end if;
  perform public.write_audit(e.id, 'registration.create', 'registration', r.id::text, p_override_reason,
    jsonb_build_object('code', v_code, 'package', pkg.code, 'counter', s.code,
                       'override', p_package_override is not null, 'tests', coalesce(array_length(p_test_ids, 1), 0)));
  v_assign := public._schedule_next(r.id);
  return jsonb_build_object('registration_id', r.id, 'registration_code', v_code, 'already', false,
                            'assignment_id', v_assign, 'payment_intent_id', v_intent,
                            'tests_intent_id', v_tests->>'intent_id');
end $$;

-- ---------------------------------------------------------------- 2. catalogue import
-- p_rows: [{code, name, category, price_paise|null, location, service_code|null, lab_order_code, instructions}]
-- Upsert by code. A blank service maps to a default "Sample collection" (event day) or
-- "Walk-in visit" (walk-in) service. A new price replaces the active one; orders keep their snapshot.
create or replace function public.import_catalog(p_event uuid, p_rows jsonb, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  x jsonb; v_code text; v_loc text; v_svc_code text; v_svc uuid; v_svc_loc text; v_test uuid; v_price bigint;
  v_cur record; n_new int := 0; n_upd int := 0; n_price int := 0; v_line int := 0;
begin
  perform public._lock_event(p_event);
  perform public.require_perm(p_event, 'catalogue.edit');
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'invalid_import: no rows'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'invalid_import: at most 2000 rows per upload'; end if;
  if exists (select 1 from jsonb_array_elements(p_rows) y where y->>'price_paise' is not null)
     and not public.has_perm(p_event, 'addon.price.edit') then
    raise exception 'permission_denied: setting prices needs addon.price.edit' using errcode = '42501';
  end if;
  perform set_config('app.reason', coalesce(nullif(btrim(p_reason), ''), 'Catalogue CSV import'), true);

  for x in select * from jsonb_array_elements(p_rows) loop
    v_line := v_line + 1;
    v_code := upper(btrim(coalesce(x->>'code', '')));
    v_loc := coalesce(nullif(x->>'location', ''), 'event_day');
    v_price := (x->>'price_paise')::bigint;
    if v_code !~ '^[A-Z0-9_-]{1,40}$' then raise exception 'invalid_import: row % has an invalid code "%"', v_line, v_code; end if;
    if coalesce(btrim(x->>'name'), '') = '' then raise exception 'invalid_import: row % has no test name', v_line; end if;
    if v_loc not in ('event_day','walk_in') then raise exception 'invalid_import: row % location must be event_day or walk_in', v_line; end if;
    if v_price is not null and v_price < 0 then raise exception 'invalid_import: row % has a negative price', v_line; end if;

    v_svc_code := upper(coalesce(nullif(btrim(x->>'service_code'), ''), case v_loc when 'walk_in' then 'WALKIN' else 'SAMPLE' end));
    if v_svc_code !~ '^[A-Z0-9_-]{1,40}$' then raise exception 'invalid_import: row % has an invalid service code', v_line; end if;
    select id, location into v_svc, v_svc_loc from workflow_services where event_id = p_event and code = v_svc_code;
    if v_svc is null then
      insert into workflow_services (event_id, code, name, location)
      values (p_event, v_svc_code, case v_svc_code when 'SAMPLE' then 'Sample collection' when 'WALKIN' then 'Walk-in visit' else initcap(replace(v_svc_code, '_', ' ')) end, v_loc)
      returning id, location into v_svc, v_svc_loc;
    end if;
    if v_svc_loc <> v_loc then
      raise exception 'invalid_import: row % (%) is %, but service % is %', v_line, v_code, v_loc, v_svc_code, v_svc_loc;
    end if;

    select id into v_test from test_catalog where event_id = p_event and code = v_code;
    if v_test is null then
      insert into test_catalog (event_id, code, display_name, category, source_wording, lab_order_code, instructions,
                                location, addon_available)
      values (p_event, v_code, btrim(x->>'name'), coalesce(btrim(x->>'category'), ''), btrim(x->>'name'),
              nullif(btrim(x->>'lab_order_code'), ''), coalesce(btrim(x->>'instructions'), ''), v_loc, v_price is not null)
      returning id into v_test;
      n_new := n_new + 1;
    else
      update test_catalog set display_name = btrim(x->>'name'), category = coalesce(btrim(x->>'category'), category),
             lab_order_code = coalesce(nullif(btrim(x->>'lab_order_code'), ''), lab_order_code),
             instructions = coalesce(nullif(btrim(x->>'instructions'), ''), instructions),
             location = v_loc, addon_available = addon_available or v_price is not null, archived = false
       where id = v_test
         and (display_name, category, location, addon_available, archived, lab_order_code, instructions) is distinct from
             (btrim(x->>'name'), coalesce(btrim(x->>'category'), category), v_loc, addon_available or v_price is not null, false,
              coalesce(nullif(btrim(x->>'lab_order_code'), ''), lab_order_code), coalesce(nullif(btrim(x->>'instructions'), ''), instructions));
      if found then n_upd := n_upd + 1; end if;
    end if;

    if not exists (select 1 from workflow_service_tests where test_id = v_test and service_id = v_svc) then
      delete from workflow_service_tests where test_id = v_test;
      insert into workflow_service_tests (event_id, service_id, test_id) values (p_event, v_svc, v_test);
    end if;

    if v_price is not null then
      select count(*) as n, min(price_paise) as lo, max(price_paise) as hi into v_cur
        from addon_prices where test_id = v_test and active;
      if not (v_cur.n = 1 and v_cur.lo = v_price) then
        update addon_prices set active = false where test_id = v_test and active;
        insert into addon_prices (event_id, test_id, price_paise) values (p_event, v_test, v_price);
        n_price := n_price + 1;
      end if;
    end if;
  end loop;

  perform public.write_audit(p_event, 'catalogue.import', 'test_catalog', null, p_reason,
    jsonb_build_object('rows', jsonb_array_length(p_rows), 'created', n_new, 'updated', n_upd, 'prices_changed', n_price));
  return jsonb_build_object('rows', jsonb_array_length(p_rows), 'created', n_new, 'updated', n_upd, 'prices_changed', n_price);
end $$;

-- ---------------------------------------------------------------- 3. queue re-check
-- Called on every render of the live staff screens (station, queue control, dashboard, participant).
-- Cheap no-op unless a waiting participant now has a compatible, open, staffed station.
create or replace function public.nudge_waiting(p_event uuid) returns int
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(p_event) then return 0; end if;
  if (select status from events where id = p_event) <> 'live' then return 0; end if;
  if not exists (
    select 1 from participant_tasks t
      join station_capabilities sc on sc.service_id = t.service_id
      join stations s on s.id = sc.station_id and s.kind = 'station' and s.status = 'open' and s.accepts_assignments
     where t.event_id = p_event and t.status = 'waiting_unassigned'
       and exists (select 1 from staff_assignments a where a.station_id = s.id and a.status = 'active'
                    and now() between a.shift_start and a.shift_end)
       and (s.max_queue is null or (select count(*) from queue_assignments q where q.station_id = s.id
                                     and q.state in ('queued','called')) < s.max_queue)) then
    return 0;
  end if;
  return public._rebalance_waiting(p_event);
end $$;

revoke execute on function public._pay_per_test_package(uuid),
  public.register_participant(uuid, text, text, text, int, text, text, text, text, boolean, uuid, text, uuid[]),
  public.import_catalog(uuid, jsonb, text), public.nudge_waiting(uuid)
from public, anon, authenticated;
grant execute on function
  public.register_participant(uuid, text, text, text, int, text, text, text, text, boolean, uuid, text, uuid[]),
  public.import_catalog(uuid, jsonb, text), public.nudge_waiting(uuid)
to authenticated;
