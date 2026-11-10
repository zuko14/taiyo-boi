-- Workflow functions: registration, package materialisation, queue scheduler,
-- task state machine, walk-in, choice groups, tags, scanning.

alter table public.events add constraint events_code_format_tokens
  check (code_format like '%{SEQ}%' and code_format like '%{CLS}%');

-- ---------------------------------------------------------------- small helpers
create or replace function public.assert_on_duty(p_station uuid, p_kinds text[]) returns public.stations
language plpgsql stable security definer set search_path = public as $$
declare s stations;
begin
  select * into s from stations where id = p_station;
  if not found then raise exception 'not_found: station'; end if;
  if not (s.kind = any (p_kinds)) then
    raise exception 'invalid_station: % is not a valid % for this action', s.name, array_to_string(p_kinds, '/');
  end if;
  if exists (select 1 from staff_assignments a
             where a.station_id = s.id and a.user_id = auth.uid() and a.status = 'active'
               and now() between a.shift_start and a.shift_end) then
    return s;
  end if;
  if public.has_perm(s.event_id, 'shift.override') then return s; end if;
  raise exception 'not_on_duty: you have no active shift at %', s.name using errcode = '42501';
end $$;

create or replace function public.assert_event_live(p_event uuid) returns void
language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  select status into v from events where id = p_event;
  if v is distinct from 'live' then
    raise exception 'event_not_live: event is %', coalesce(v, 'missing');
  end if;
end $$;

create or replace function public._lock_event(p_event uuid) returns void
language sql security definer set search_path = public as $$
  -- Serialises every write that can change queue state for one event. Taken at the start of
  -- each entry point, before any row locks, so lock order is always: event -> rows.
  select pg_advisory_xact_lock(hashtextextended('event-ops:' || p_event::text, 0))
$$;

create or replace function public._set_task_status(
  p_task uuid, p_to text, p_reason text, p_source text, p_station uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_from text; v_event uuid;
begin
  select status, event_id into v_from, v_event from participant_tasks where id = p_task;
  if v_from = p_to then return; end if;
  update participant_tasks
     set status = p_to, status_reason = p_reason, updated_at = now(),
         waiting_since = case when p_to = 'waiting_unassigned' then coalesce(waiting_since, now()) end
   where id = p_task;
  insert into task_status_history (event_id, task_id, from_status, to_status, actor_id, station_id, reason, source)
  values (v_event, p_task, v_from, p_to, auth.uid(), p_station, p_reason, p_source);
end $$;

-- Attendance ledger: one row per order line per kind; retries are no-ops.
create or replace function public._record_attendance(p_task uuid, p_kind text)
returns void language sql security definer set search_path = public as $$
  insert into task_attendance_events (event_id, registration_id, order_item_id, test_id, package_id,
                                      source, kind, task_id, station_id, actor_id)
  select oi.event_id, oi.registration_id, oi.id, oi.test_id,
         case when oi.source = 'package' then r.package_id end,
         oi.source, p_kind, t.id, t.station_id, auth.uid()
    from task_items ti
    join order_items oi on oi.id = ti.order_item_id
    join participant_tasks t on t.id = ti.task_id
    join registrations r on r.id = oi.registration_id
   where ti.task_id = p_task and oi.status = 'active'
     and (p_kind <> 'completed' or oi.completion_rule = 'fulfilled_on_complete')
  on conflict (order_item_id, kind) do nothing
$$;

-- ---------------------------------------------------------------- package snapshot
create or replace function public.build_package_snapshot(p_package uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'package', (select jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name,
                       'classification', p.classification, 'description', p.description)
                  from packages p where p.id = p_package),
    'tests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'package_test_id', pt.id, 'test_id', t.id, 'code', t.code, 'name', t.display_name,
               'location', t.location, 'required', pt.required, 'priority', pt.priority,
               'fasting', pt.fasting_required, 'choice_group_id', pt.choice_group_id,
               'service_id', wst.service_id,
               'completion_rule', coalesce(wst.completion_rule, 'fulfilled_on_complete'),
               'depends_on_test_ids', to_jsonb(pt.depends_on_test_ids))
             order by pt.priority, t.code)
        from package_tests pt
        join test_catalog t on t.id = pt.test_id
        left join workflow_service_tests wst on wst.test_id = t.id
       where pt.package_id = p_package and t.active and not t.archived), '[]'::jsonb),
    'choice_groups', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'code', g.code, 'name', g.name, 'rule', g.rule,
               'separate_tasks', g.separate_tasks, 'service_id', g.service_id, 'required', g.required)
             order by g.code)
        from choice_groups g where g.package_id = p_package), '[]'::jsonb),
    'services', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name,
               'location', s.location, 'priority', s.priority) order by s.code)
        from workflow_services s
       where s.event_id = (select event_id from packages where id = p_package)), '[]'::jsonb))
$$;

create or replace function public._package_version(p_package uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_snap jsonb := public.build_package_snapshot(p_package);
  v_hash text := md5(v_snap::text);
  v_id uuid;
  v_event uuid;
begin
  select event_id into v_event from packages where id = p_package;
  insert into package_configuration_versions (event_id, package_id, snapshot_hash, snapshot, created_by)
  values (v_event, p_package, v_hash, v_snap, auth.uid())
  on conflict (package_id, snapshot_hash) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from package_configuration_versions where package_id = p_package and snapshot_hash = v_hash;
  end if;
  return v_id;
end $$;

-- Create sponsor order lines + queueable service tasks from a snapshot.
-- p_only_tests limits materialisation to particular tests (used by config migration).
create or replace function public._materialize_package(p_reg uuid, p_snapshot jsonb, p_only_tests uuid[] default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  r registrations;
  v_order uuid;
  g jsonb;
  grp record;
  v_task uuid;
  v_deps uuid[];
  v_loc text;
  v_svc_name text;
begin
  select * into r from registrations where id = p_reg;
  select id into v_order from orders where registration_id = p_reg and kind = 'package' and status = 'active' limit 1;
  if v_order is null then
    insert into orders (event_id, registration_id, kind, created_by)
    values (r.event_id, p_reg, 'package', auth.uid()) returning id into v_order;
  end if;

  create temp table if not exists _mat_items (
    order_item_id uuid, test_id uuid, service_id uuid, location text,
    priority int, fasting boolean, deps uuid[]) on commit drop;
  delete from _mat_items where true;  -- pg_safeupdate needs a WHERE

  with src as (
    select (x->>'test_id')::uuid as test_id, x->>'code' as code, x->>'name' as name,
           x->>'location' as location, (x->>'priority')::int as priority,
           (x->>'fasting')::boolean as fasting, (x->>'service_id')::uuid as service_id,
           x->>'completion_rule' as rule,
           array(select jsonb_array_elements_text(x->'depends_on_test_ids'))::uuid[] as deps
      from jsonb_array_elements(p_snapshot->'tests') x
     where x->>'choice_group_id' is null
       and (p_only_tests is null or (x->>'test_id')::uuid = any (p_only_tests))
  ), ins as (
    insert into order_items (event_id, order_id, registration_id, test_id, test_code, test_name,
                             location, source, responsibility, completion_rule)
    select r.event_id, v_order, p_reg, test_id, code, name, location, 'package', 'sponsor', rule from src
    returning id, test_id
  )
  insert into _mat_items
  select ins.id, src.test_id, src.service_id, src.location, src.priority, src.fasting, src.deps
    from ins join src using (test_id);

  if exists (select 1 from _mat_items where service_id is null) then
    raise exception 'config_invalid: a package test has no workflow service mapping';
  end if;

  for grp in
    select service_id, location, min(priority) as pr, bool_or(fasting) as fasting,
           array_agg(order_item_id) as items
      from _mat_items group by service_id, location
  loop
    select coalesce(array_agg(distinct (y->>'service_id')::uuid), '{}') into v_deps
      from jsonb_array_elements(p_snapshot->'tests') y
     where (y->>'test_id')::uuid in (select unnest(deps) from _mat_items where service_id = grp.service_id)
       and (y->>'service_id')::uuid is distinct from grp.service_id;
    select s->>'name' into v_svc_name from jsonb_array_elements(p_snapshot->'services') s
     where (s->>'id')::uuid = grp.service_id;

    insert into participant_tasks (event_id, registration_id, service_id, service_name, location, source,
                                   status, priority, fasting_required, depends_on_service_ids)
    values (r.event_id, p_reg, grp.service_id, coalesce(v_svc_name, 'Service'), grp.location, 'package',
            case grp.location when 'walk_in' then 'not_attended' else 'not_ready' end,
            grp.pr, grp.fasting, v_deps)
    returning id into v_task;
    insert into task_items (task_id, order_item_id) select v_task, unnest(grp.items);
    insert into task_status_history (event_id, task_id, to_status, actor_id, source)
    select r.event_id, v_task, status, auth.uid(), 'registration' from participant_tasks where id = v_task;
  end loop;

  -- choice groups: one task per group, waiting for the participant's selection (bundled = all options)
  for g in select x from jsonb_array_elements(p_snapshot->'choice_groups') x loop
    continue when exists (select 1 from participant_tasks
                          where registration_id = p_reg and choice_group_id = (g->>'id')::uuid
                            and status <> 'cancelled');
    continue when p_only_tests is not null and not exists (
      select 1 from jsonb_array_elements(p_snapshot->'tests') y
       where y->>'choice_group_id' = g->>'id' and (y->>'test_id')::uuid = any (p_only_tests));
    select s->>'location', s->>'name' into v_loc, v_svc_name
      from jsonb_array_elements(p_snapshot->'services') s where s->>'id' = g->>'service_id';
    insert into participant_tasks (event_id, registration_id, service_id, service_name, location, source,
                                   status, choice_group_id)
    values (r.event_id, p_reg, (g->>'service_id')::uuid, g->>'name', v_loc, 'package',
            case when g->>'rule' = 'bundled' then case v_loc when 'walk_in' then 'not_attended' else 'not_ready' end
                 else 'awaiting_choice' end,
            (g->>'id')::uuid)
    returning id into v_task;
    insert into task_status_history (event_id, task_id, to_status, actor_id, source)
    select r.event_id, v_task, status, auth.uid(), 'registration' from participant_tasks where id = v_task;
    if g->>'rule' = 'bundled' then
      with ins as (
        insert into order_items (event_id, order_id, registration_id, test_id, test_code, test_name, location,
                                 source, responsibility, completion_rule, choice_group_id)
        select r.event_id, v_order, p_reg, (y->>'test_id')::uuid, y->>'code', y->>'name', y->>'location',
               'package', 'sponsor', y->>'completion_rule', (g->>'id')::uuid
          from jsonb_array_elements(p_snapshot->'tests') y where y->>'choice_group_id' = g->>'id'
        returning id)
      insert into task_items (task_id, order_item_id) select v_task, id from ins;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- queue scheduler
create or replace function public._task_eligible(t public.participant_tasks) returns boolean
language sql stable security definer set search_path = public as $$
  select t.location = 'event_day'
     and t.status in ('not_ready', 'waiting_unassigned')
     and (t.payment_intent_id is null or t.payment_exception
          or exists (select 1 from payment_intents p where p.id = t.payment_intent_id and p.status in ('paid','waived')))
     and not exists (select 1 from participant_tasks d
                      where d.registration_id = t.registration_id and d.id <> t.id
                        and d.service_id = any (t.depends_on_service_ids)
                        and d.status not in ('completed','skipped','cancelled'))
$$;

-- Deterministic allocation: lab-approved priority first, then lowest estimated wait among
-- compatible open staffed stations, then round-robin (oldest last assignment), then code.
create or replace function public._schedule_next(p_reg uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  r registrations;
  v_default int;
  v_pick record;
  v_seq int;
  v_assign uuid;
begin
  perform public._lock_event((select event_id from registrations where id = p_reg));
  select * into r from registrations where id = p_reg for update;
  if not found or r.status <> 'active' then return null; end if;
  if (select status from events where id = r.event_id) <> 'live' then return null; end if;
  if exists (select 1 from queue_assignments where registration_id = p_reg
             and state in ('queued','called','in_service')) then
    return null;
  end if;
  v_default := coalesce((public.event_setting(r.event_id, 'default_service_minutes'))::int, 5);


  with elig as (
    select t.* from participant_tasks t where t.registration_id = p_reg and public._task_eligible(t)
  ), cand as (
    select e.id as task_id, e.priority, s.id as station_id, s.code, s.last_assigned_at, s.capacity, s.max_queue,
           (select count(*) from queue_assignments q where q.station_id = s.id
             and q.state in ('queued','called','in_service')) as active_n,
           (select count(*) from queue_assignments q where q.station_id = s.id
             and q.state in ('queued','called')) as waiting_n,
           (select count(distinct a.user_id) from staff_assignments a where a.station_id = s.id
             and a.status = 'active' and now() between a.shift_start and a.shift_end) as staff_n,
           coalesce(ws.est_minutes, s.avg_service_minutes, v_default) as minutes
      from elig e
      join workflow_services ws on ws.id = e.service_id and ws.location = 'event_day'
      join station_capabilities sc on sc.service_id = e.service_id
      join stations s on s.id = sc.station_id
     where s.kind = 'station' and s.status = 'open' and s.accepts_assignments
  ), scored as (
    select c.*, round(c.active_n * c.minutes::numeric / greatest(1, least(c.capacity, c.staff_n)), 1) as est_wait
      from cand c
     where c.staff_n > 0 and (c.max_queue is null or c.waiting_n < c.max_queue)
  )
  select s.*,
         count(*) over (partition by s.task_id) as n_compatible,
         jsonb_agg(jsonb_build_object('task_id', s.task_id, 'station', s.code, 'est_wait_min', s.est_wait,
                   'in_queue', s.active_n, 'staff', s.staff_n, 'priority', s.priority)) over () as all_candidates
    into v_pick
    from scored s
   order by s.priority, s.est_wait, s.last_assigned_at nulls first, s.code
   limit 1;

  if not found then
    -- eligible work but nowhere to send it: visible to supervisors as waiting_unassigned
    perform public._set_task_status(t.id, 'waiting_unassigned', 'No compatible open, staffed station available',
                                    'scheduler', null)
       from participant_tasks t where t.registration_id = p_reg and public._task_eligible(t);
    return null;
  end if;

  update stations set next_seq = next_seq + 1, last_assigned_at = clock_timestamp()
   where id = v_pick.station_id returning next_seq - 1 into v_seq;

  insert into queue_assignments (event_id, task_id, registration_id, station_id, seq, reason, score)
  values (r.event_id, v_pick.task_id, p_reg, v_pick.station_id, v_seq,
          format('Priority %s; lowest estimated wait (%s min, %s in queue) among %s compatible open staffed station(s)',
                 v_pick.priority, v_pick.est_wait, v_pick.active_n, v_pick.n_compatible),
          jsonb_build_object('policy', 'priority > lowest_estimated_wait > round_robin > code',
                             'candidates', v_pick.all_candidates))
  returning id into v_assign;

  update participant_tasks set station_id = v_pick.station_id where id = v_pick.task_id;
  perform public._set_task_status(v_pick.task_id, 'queued', null, 'scheduler', v_pick.station_id);
  -- participant is now busy; other waiting tasks go back to not_ready until their turn
  perform public._set_task_status(t.id, 'not_ready', null, 'scheduler', null)
     from participant_tasks t where t.registration_id = p_reg and t.status = 'waiting_unassigned';
  return v_assign;
end $$;

create or replace function public._rebalance_waiting(p_event uuid) returns int
language plpgsql security definer set search_path = public as $$
declare v_reg uuid; n int := 0;
begin
  perform public._lock_event(p_event);
  for v_reg in
    select t.registration_id from participant_tasks t
     where t.event_id = p_event and t.status = 'waiting_unassigned'
       and not exists (select 1 from queue_assignments q where q.registration_id = t.registration_id
                         and q.state in ('queued','called','in_service'))
     group by t.registration_id order by min(t.waiting_since)
  loop
    if public._schedule_next(v_reg) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

create or replace function public.rebalance_waiting(p_event uuid) returns int
language plpgsql security definer set search_path = public as $$
begin
  perform public._lock_event(p_event);
  perform public.require_perm(p_event, 'queue.override');
  return public._rebalance_waiting(p_event);
end $$;

-- Defence in depth: no code path may create an incompatible assignment.
create or replace function public.queue_assignment_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from participant_tasks t
      join workflow_services ws on ws.id = t.service_id
      join stations s on s.id = new.station_id
      join station_capabilities sc on sc.station_id = s.id and sc.service_id = t.service_id
     where t.id = new.task_id and t.registration_id = new.registration_id
       and t.location = 'event_day' and ws.location = 'event_day'
       and s.kind = 'station' and s.event_id = t.event_id) then
    raise exception 'incompatible_station: station cannot perform this service';
  end if;
  return new;
end $$;
create trigger queue_assignment_guard before insert or update of station_id on public.queue_assignments
  for each row execute function public.queue_assignment_guard();

-- ---------------------------------------------------------------- registration
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

  if p_classification not in ('female','male') then
    raise exception 'invalid_classification: choose Female or Male';
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

create or replace function public.find_possible_duplicates(
  p_event uuid, p_employee_id text, p_mobile text, p_name text)
returns table (registration_id uuid, registration_code text, full_name text, employee_id text,
               mobile_last4 text, classification text, status text, created_at timestamptz, match text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_perm(p_event, 'registration.create');
  return query
  select r.id, r.registration_code, p.full_name, p.employee_id, right(p.mobile, 4), r.classification, r.status,
         r.created_at,
         concat_ws(', ',
           case when nullif(btrim(p_employee_id), '') is not null and p.employee_id = btrim(p_employee_id) then 'employee ID' end,
           case when nullif(btrim(p_mobile), '') is not null and p.mobile = btrim(p_mobile) then 'mobile' end,
           case when nullif(btrim(p_name), '') is not null
                 and p.name_search = lower(regexp_replace(btrim(p_name), '\s+', ' ', 'g')) then 'name' end)
    from registrations r join participants p on p.id = r.participant_id
   where r.event_id = p_event
     and ((nullif(btrim(p_employee_id), '') is not null and p.employee_id = btrim(p_employee_id))
       or (nullif(btrim(p_mobile), '') is not null and p.mobile = btrim(p_mobile))
       or (nullif(btrim(p_name), '') is not null
           and p.name_search = lower(regexp_replace(btrim(p_name), '\s+', ' ', 'g'))))
   order by r.created_at
   limit 20;
end $$;

create or replace function public.correct_registration(
  p_reg uuid, p_full_name text, p_age int, p_employee_id text, p_mobile text,
  p_email text, p_department text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare r registrations; v_before jsonb;
begin
  select * into r from registrations where id = p_reg;
  if not found then raise exception 'not_found: registration'; end if;
  perform public.require_perm(r.event_id, 'registration.correct');
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  select to_jsonb(p) - 'name_search' into v_before from participants p where id = r.participant_id;
  update participants set full_name = btrim(p_full_name), age = p_age,
         employee_id = nullif(btrim(p_employee_id), ''), mobile = nullif(btrim(p_mobile), ''),
         email = nullif(btrim(p_email), ''), department = nullif(btrim(p_department), '')
   where id = r.participant_id;
  perform public.write_audit(r.event_id, 'registration.correct', 'registration', r.id::text, p_reason,
    jsonb_build_object('before', v_before));
end $$;

-- Supervisor duplicate resolution: never merges or deletes; voids the duplicate and links it.
create or replace function public.resolve_duplicate(p_duplicate uuid, p_keep uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare d registrations; k registrations;
begin
  perform public._lock_event((select event_id from registrations where id = p_duplicate));
  select * into d from registrations where id = p_duplicate for update;
  select * into k from registrations where id = p_keep;
  if d.id is null or k.id is null or d.event_id <> k.event_id or d.id = k.id then
    raise exception 'invalid_duplicate_pair';
  end if;
  perform public.require_perm(d.event_id, 'registration.duplicate_resolve');
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  if d.status <> 'active' then raise exception 'already_resolved'; end if;
  if exists (select 1 from participant_tasks where registration_id = d.id
             and status in ('in_service','completed','checked_in')) then
    raise exception 'duplicate_has_activity: tasks were already performed on this registration; resolve manually';
  end if;
  update queue_assignments set state = 'cancelled', ended_at = now()
   where registration_id = d.id and state in ('queued','called','in_service');
  perform public._set_task_status(t.id, 'cancelled', 'Duplicate registration: ' || p_reason, 'supervisor', null)
     from participant_tasks t where t.registration_id = d.id and t.status not in ('completed','cancelled');
  update registration_tokens set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'duplicate'
   where registration_id = d.id and revoked_at is null;
  update registrations set status = 'duplicate_void', duplicate_of = k.id where id = d.id;
  perform public.write_audit(d.event_id, 'registration.duplicate_resolve', 'registration', d.id::text, p_reason,
    jsonb_build_object('kept', k.registration_code, 'voided', d.registration_code));
end $$;

-- Explicit, audited migration of one registration to the current package configuration.
create or replace function public.migrate_registration_config(p_reg uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r registrations; v_version uuid; v_new jsonb; v_added uuid[]; v_removed int := 0;
begin
  perform public._lock_event((select event_id from registrations where id = p_reg));
  select * into r from registrations where id = p_reg for update;
  if not found then raise exception 'not_found: registration'; end if;
  perform public.require_perm(r.event_id, 'live_configuration.override');
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  v_version := public._package_version(r.package_id);
  if v_version = r.package_version_id then return jsonb_build_object('changed', false); end if;
  select snapshot into v_new from package_configuration_versions where id = v_version;

  select coalesce(array_agg((x->>'test_id')::uuid), '{}') into v_added
    from jsonb_array_elements(v_new->'tests') x
   where not exists (select 1 from order_items oi where oi.registration_id = r.id and oi.source = 'package'
                       and oi.status = 'active' and oi.test_id = (x->>'test_id')::uuid)
     and (x->>'choice_group_id' is null
          or not exists (select 1 from participant_tasks t where t.registration_id = r.id
                           and t.choice_group_id = (x->>'choice_group_id')::uuid and t.status <> 'cancelled'));
  if array_length(v_added, 1) > 0 then
    perform public._materialize_package(r.id, v_new, v_added);
  end if;

  -- removed tests: cancel only lines whose task has not started
  with gone as (
    select oi.id, ti.task_id from order_items oi join task_items ti on ti.order_item_id = oi.id
      join participant_tasks t on t.id = ti.task_id
     where oi.registration_id = r.id and oi.source = 'package' and oi.status = 'active'
       and t.status in ('not_ready','waiting_unassigned','not_attended','awaiting_choice','queued','called')
       and not exists (select 1 from jsonb_array_elements(v_new->'tests') x where (x->>'test_id')::uuid = oi.test_id))
  update order_items set status = 'cancelled' where id in (select id from gone);
  get diagnostics v_removed = row_count;
  perform public._set_task_status(t.id, 'cancelled', 'Configuration migration: ' || p_reason, 'supervisor', null)
     from participant_tasks t
    where t.registration_id = r.id and t.status not in ('completed','cancelled','in_service','checked_in')
      and not exists (select 1 from task_items ti join order_items oi on oi.id = ti.order_item_id
                       where ti.task_id = t.id and oi.status = 'active')
      and t.status <> 'awaiting_choice';
  update queue_assignments q set state = 'cancelled', ended_at = now()
    from participant_tasks t where q.task_id = t.id and t.registration_id = r.id
     and t.status = 'cancelled' and q.state in ('queued','called');

  update registrations set package_version_id = v_version where id = r.id;
  perform public.write_audit(r.event_id, 'registration.config_migrate', 'registration', r.id::text, p_reason,
    jsonb_build_object('from_version', r.package_version_id, 'to_version', v_version,
                       'added_tests', v_added, 'cancelled_lines', v_removed));
  perform public._schedule_next(r.id);
  return jsonb_build_object('changed', true, 'added', coalesce(array_length(v_added, 1), 0), 'cancelled', v_removed);
end $$;

-- ---------------------------------------------------------------- choice groups
create or replace function public.select_choice(p_reg uuid, p_group uuid, p_test_ids uuid[], p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  r registrations; v_snap jsonb; g jsonb; t participant_tasks;
  v_options uuid[]; v_n int; v_order uuid; v_first boolean := true; v_test uuid; v_task uuid;
begin
  perform public._lock_event((select event_id from registrations where id = p_reg));
  select * into r from registrations where id = p_reg;
  if not found or r.status <> 'active' then raise exception 'registration_inactive'; end if;
  perform public.require_perm(r.event_id, 'choice.select');
  select snapshot into v_snap from package_configuration_versions where id = r.package_version_id;
  select x into g from jsonb_array_elements(v_snap->'choice_groups') x where (x->>'id')::uuid = p_group;
  if g is null then raise exception 'not_found: choice group not in this participant''s package'; end if;
  select coalesce(array_agg((y->>'test_id')::uuid), '{}') into v_options
    from jsonb_array_elements(v_snap->'tests') y where (y->>'choice_group_id')::uuid = p_group;
  select count(distinct x) into v_n from unnest(p_test_ids) x;
  if v_n = 0 or not (p_test_ids <@ v_options) then raise exception 'invalid_choice'; end if;
  if g->>'rule' = 'one_of' and v_n <> 1 then raise exception 'invalid_choice: select exactly one option'; end if;
  if g->>'rule' = 'bundled' then raise exception 'invalid_choice: bundled group needs no selection'; end if;

  select * into t from participant_tasks where registration_id = p_reg and choice_group_id = p_group
     and status <> 'cancelled' order by created_at limit 1 for update;
  if t.id is null then raise exception 'not_found: choice task'; end if;
  if t.status not in ('awaiting_choice','not_attended','not_ready') then
    raise exception 'choice_locked: the service has already started';
  end if;
  if (select count(*) from participant_tasks where registration_id = p_reg and choice_group_id = p_group
      and status <> 'cancelled') > 1 then
    raise exception 'choice_locked: separate option tasks exist; cancel them first';
  end if;

  update order_items set status = 'cancelled'
   where id in (select order_item_id from task_items where task_id = t.id) and status = 'active'
     and not (test_id = any (p_test_ids));
  select id into v_order from orders where registration_id = p_reg and kind = 'package' and status = 'active' limit 1;

  foreach v_test in array (select array_agg(distinct x) from unnest(p_test_ids) x) loop
    if (g->>'separate_tasks')::boolean and not v_first then
      insert into participant_tasks (event_id, registration_id, service_id, service_name, location, source,
                                     status, choice_group_id)
      select event_id, registration_id, service_id, service_name, location, source,
             case location when 'walk_in' then 'not_attended' else 'not_ready' end, choice_group_id
        from participant_tasks where id = t.id returning id into v_task;
    else
      v_task := t.id;
    end if;
    v_first := false;
    if not exists (select 1 from order_items oi join task_items ti on ti.order_item_id = oi.id
                    where ti.task_id = t.id and oi.test_id = v_test and oi.status = 'active') then
      with ins as (
        insert into order_items (event_id, order_id, registration_id, test_id, test_code, test_name, location,
                                 source, responsibility, completion_rule, choice_group_id)
        select r.event_id, v_order, p_reg, v_test, y->>'code', y->>'name', y->>'location', 'package', 'sponsor',
               y->>'completion_rule', p_group
          from jsonb_array_elements(v_snap->'tests') y where (y->>'test_id')::uuid = v_test
        returning id)
      insert into task_items (task_id, order_item_id) select v_task, id from ins;
    end if;
  end loop;

  perform public._set_task_status(t.id, case t.location when 'walk_in' then 'not_attended' else 'not_ready' end,
                                  'Choice recorded', 'user', null);
  perform public.write_audit(r.event_id, 'choice.select', 'participant_task', t.id::text, p_reason,
    jsonb_build_object('group', g->>'code', 'tests', p_test_ids));
  if t.location = 'event_day' then perform public._schedule_next(p_reg); end if;
end $$;

-- ---------------------------------------------------------------- task state machine
create or replace function public.task_action(p_task uuid, p_action text, p_station uuid default null,
                                              p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t participant_tasks; v_target text; v_allowed text[]; v_perm text; v_need_reason boolean := false;
  v_qa queue_assignments; v_next uuid; v_visit uuid; v_tz text;
begin
  perform public._lock_event((select event_id from participant_tasks where id = p_task));
  select * into t from participant_tasks where id = p_task for update;
  if not found then raise exception 'not_found: task'; end if;
  perform set_config('app.reason', coalesce(p_reason, ''), true);
  perform public.assert_event_live(t.event_id);
  if (select status from registrations where id = t.registration_id) <> 'active' then
    raise exception 'registration_inactive';
  end if;

  if t.location = 'event_day' then
    case p_action
      when 'call'      then v_target := 'called';     v_allowed := array['queued']; v_perm := 'task.perform';
      when 'start'     then v_target := 'in_service'; v_allowed := array['queued','called']; v_perm := 'task.perform';
      when 'complete'  then v_target := 'completed';  v_allowed := array['in_service']; v_perm := 'task.perform';
      when 'no_show'   then v_target := 'no_show';    v_allowed := array['queued','called']; v_perm := 'task.perform'; v_need_reason := true;
      when 'exception' then v_target := 'exception';  v_allowed := array['queued','called','in_service']; v_perm := 'task.perform'; v_need_reason := true;
      when 'skip'      then v_target := 'skipped';    v_allowed := array['not_ready','waiting_unassigned','queued','called']; v_perm := 'task.skip'; v_need_reason := true;
      when 'cancel'    then v_target := 'cancelled';  v_allowed := array['not_ready','waiting_unassigned','queued','called','awaiting_choice','exception','no_show']; v_perm := 'task.skip'; v_need_reason := true;
      when 'requeue'   then v_target := 'not_ready';  v_allowed := array['no_show','exception','waiting_unassigned','skipped']; v_perm := 'queue.override'; v_need_reason := true;
      else raise exception 'invalid_action: %', p_action;
    end case;
  else
    case p_action
      when 'checkin'   then v_target := 'checked_in'; v_allowed := array['not_attended']; v_perm := 'walkin.checkin';
      when 'start'     then v_target := 'in_service'; v_allowed := array['checked_in']; v_perm := 'walkin.perform';
      when 'complete'  then v_target := 'completed';  v_allowed := array['in_service']; v_perm := 'walkin.perform';
      when 'no_show'   then v_target := 'no_show';    v_allowed := array['not_attended','checked_in']; v_perm := 'walkin.perform'; v_need_reason := true;
      when 'exception' then v_target := 'exception';  v_allowed := array['checked_in','in_service']; v_perm := 'walkin.perform'; v_need_reason := true;
      when 'cancel'    then v_target := 'cancelled';  v_allowed := array['not_attended','awaiting_choice','checked_in','exception','no_show']; v_perm := 'task.skip'; v_need_reason := true;
      when 'requeue'   then v_target := 'not_attended'; v_allowed := array['exception','no_show']; v_perm := 'queue.override'; v_need_reason := true;
      else raise exception 'invalid_action: % is not valid for a walk-in task', p_action;
    end case;
  end if;

  perform public.require_perm(t.event_id, v_perm);
  if t.status = v_target then
    return jsonb_build_object('ok', true, 'already', true, 'status', t.status);
  end if;
  if not (t.status = any (v_allowed)) then
    raise exception 'illegal_transition: cannot % a task that is %', p_action, t.status;
  end if;
  if v_need_reason and coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;

  if t.location = 'event_day' and p_action in ('call','start','complete','no_show','exception') then
    if p_station is null then raise exception 'station_required'; end if;
    perform public.assert_on_duty(p_station, array['station']);
    if t.station_id is distinct from p_station then
      raise exception 'wrong_station: this task is assigned to another station';
    end if;
  end if;
  if t.location = 'walk_in' and p_action in ('checkin','start','complete','no_show','exception') then
    if p_station is null then raise exception 'station_required'; end if;
    perform public.assert_on_duty(p_station, array['walkin_centre']);
    if not exists (select 1 from station_capabilities where station_id = p_station and service_id = t.service_id) then
      raise exception 'incompatible_station: this centre is not configured for %', t.service_name;
    end if;
    if p_action <> 'checkin' and t.station_id is not null and t.station_id <> p_station then
      raise exception 'wrong_station: participant checked in at another centre';
    end if;
    if p_action = 'checkin' and t.payment_intent_id is not null and not t.payment_exception
       and not exists (select 1 from payment_intents where id = t.payment_intent_id and status in ('paid','waived')) then
      raise exception 'payment_pending: add-on payment has not been verified';
    end if;
  end if;

  select * into v_qa from queue_assignments where task_id = t.id and state in ('queued','called','in_service') for update;
  if v_qa.id is not null then
    if v_target = 'called' then
      update queue_assignments set state = 'called', called_at = now() where id = v_qa.id;
    elsif v_target = 'in_service' then
      update queue_assignments set state = 'in_service', started_at = now(), called_at = coalesce(called_at, now())
       where id = v_qa.id;
    else
      update queue_assignments set ended_at = now(),
             state = case v_target when 'completed' then 'completed' when 'no_show' then 'no_show'
                                   when 'exception' then 'exception' else 'cancelled' end
       where id = v_qa.id;
    end if;
  elsif t.location = 'event_day' and p_action in ('call','start') then
    raise exception 'not_queued: task has no active queue assignment';
  end if;

  if v_target = 'checked_in' then
    select timezone into v_tz from events where id = t.event_id;
    insert into walkin_visits (event_id, registration_id, centre_id, visit_date, checked_in_by)
    values (t.event_id, t.registration_id, p_station, (now() at time zone v_tz)::date, auth.uid())
    on conflict (registration_id, centre_id, visit_date) do update set visit_date = excluded.visit_date
    returning id into v_visit;
    update participant_tasks set walkin_visit_id = v_visit, station_id = p_station where id = t.id;
  end if;
  if v_target in ('not_ready','not_attended') then
    update participant_tasks set station_id = null where id = t.id;
  end if;
  if v_target in ('in_service','checked_in') then
    update registrations set arrived_at = coalesce(arrived_at, now()) where id = t.registration_id;
    perform public._record_attendance(t.id, 'appeared');
  elsif v_target = 'completed' then
    update participant_tasks set completed_at = now(), completed_by = auth.uid() where id = t.id;
    perform public._record_attendance(t.id, 'appeared');
    perform public._record_attendance(t.id, 'completed');
  elsif v_target in ('no_show','exception') then
    perform public._record_attendance(t.id, v_target);
  end if;

  perform public._set_task_status(t.id, v_target, p_reason, 'user', p_station);
  perform public.write_audit(t.event_id, 'task.' || p_action, 'participant_task', t.id::text, p_reason,
    jsonb_build_object('from', t.status, 'to', v_target, 'station', p_station));

  if t.location = 'event_day' and v_target in ('completed','no_show','exception','skipped','cancelled','not_ready') then
    v_next := public._schedule_next(t.registration_id);
  end if;
  return jsonb_build_object('ok', true, 'status', v_target, 'next_assignment', v_next);
end $$;

-- Confirm an individual order line inside a grouped encounter (completion_rule = manual_confirm).
create or replace function public.confirm_order_item(p_order_item uuid, p_station uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare oi order_items; t participant_tasks;
begin
  select * into oi from order_items where id = p_order_item;
  if not found then raise exception 'not_found: order item'; end if;
  select pt.* into t from participant_tasks pt join task_items ti on ti.task_id = pt.id
   where ti.order_item_id = oi.id order by pt.created_at desc limit 1;
  perform public.require_perm(oi.event_id, case t.location when 'walk_in' then 'walkin.perform' else 'task.perform' end);
  perform public.assert_on_duty(p_station, array['station','walkin_centre']);
  if t.status not in ('in_service','completed') then raise exception 'illegal_transition: service not started'; end if;
  insert into task_attendance_events (event_id, registration_id, order_item_id, test_id, package_id, source, kind,
                                      task_id, station_id, actor_id)
  select oi.event_id, oi.registration_id, oi.id, oi.test_id, case when oi.source = 'package' then r.package_id end,
         oi.source, 'completed', t.id, p_station, auth.uid()
    from registrations r where r.id = oi.registration_id
  on conflict (order_item_id, kind) do nothing;
  perform public.write_audit(oi.event_id, 'order_item.confirm', 'order_item', oi.id::text, p_reason, '{}');
end $$;

create or replace function public.call_next(p_station uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s stations; v_task uuid;
begin
  perform public._lock_event((select event_id from stations where id = p_station));
  s := public.assert_on_duty(p_station, array['station']);
  perform public.require_perm(s.event_id, 'task.perform');
  perform public._rebalance_waiting(s.event_id);    -- pull waiting participants first
  select task_id into v_task from queue_assignments
   where station_id = p_station and state = 'queued' order by seq limit 1;
  if v_task is null then return jsonb_build_object('ok', true, 'empty', true); end if;
  return public.task_action(v_task, 'call', p_station, null);
end $$;

create or replace function public.reassign_task(p_task uuid, p_target_station uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t participant_tasks; s stations; v_seq int; v_assign uuid;
begin
  perform public._lock_event((select event_id from participant_tasks where id = p_task));
  select * into t from participant_tasks where id = p_task for update;
  if not found then raise exception 'not_found: task'; end if;
  perform public.require_perm(t.event_id, 'queue.override');
  perform public.assert_event_live(t.event_id);
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  if t.location <> 'event_day' or t.status not in ('queued','called','waiting_unassigned','not_ready') then
    raise exception 'illegal_transition: only waiting event-day tasks can be reassigned (not %)', t.status;
  end if;
  perform 1 from registrations where id = t.registration_id for update;
  if t.status = 'not_ready' and not public._task_eligible(t) then raise exception 'not_eligible'; end if;
  if exists (select 1 from queue_assignments where registration_id = t.registration_id and task_id <> t.id
             and state in ('queued','called','in_service')) then
    raise exception 'participant_busy: participant already has another active assignment';
  end if;

  update queue_assignments set state = 'reassigned', ended_at = now()
   where task_id = t.id and state in ('queued','called');
  update participant_tasks set station_id = null where id = t.id;
  perform public._set_task_status(t.id, 'not_ready', 'Reassignment: ' || p_reason, 'supervisor', null);

  if p_target_station is null then
    v_assign := public._schedule_next(t.registration_id);
  else
    select * into s from stations where id = p_target_station and event_id = t.event_id for update;
    if s.id is null or s.status <> 'open' then raise exception 'station_unavailable'; end if;
    update stations set next_seq = next_seq + 1, last_assigned_at = clock_timestamp()
     where id = s.id returning next_seq - 1 into v_seq;
    insert into queue_assignments (event_id, task_id, registration_id, station_id, seq, reason, assigned_by)
    values (t.event_id, t.id, t.registration_id, s.id, v_seq, 'Manual reassignment: ' || p_reason, auth.uid())
    returning id into v_assign;      -- guard trigger rejects incompatible stations
    update participant_tasks set station_id = s.id where id = t.id;
    perform public._set_task_status(t.id, 'queued', 'Reassignment: ' || p_reason, 'supervisor', s.id);
  end if;
  perform public.write_audit(t.event_id, 'queue.reassign', 'participant_task', t.id::text, p_reason,
    jsonb_build_object('target', p_target_station));
  return jsonb_build_object('ok', true, 'assignment_id', v_assign);
end $$;

create or replace function public.grant_payment_exception(p_task uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare t participant_tasks;
begin
  perform public._lock_event((select event_id from participant_tasks where id = p_task));
  select * into t from participant_tasks where id = p_task for update;
  perform public.require_perm(t.event_id, 'payment.exception');
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  update participant_tasks set payment_exception = true where id = t.id;
  perform public.write_audit(t.event_id, 'payment.exception', 'participant_task', t.id::text, p_reason, '{}');
  perform public._schedule_next(t.registration_id);
end $$;

-- ---------------------------------------------------------------- stations & shifts
create or replace function public.station_set_status(p_station uuid, p_status text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s stations; q record; n int := 0;
begin
  perform public._lock_event((select event_id from stations where id = p_station));
  select * into s from stations where id = p_station for update;
  if not found then raise exception 'not_found: station'; end if;
  perform public.require_perm(s.event_id, 'station.operate');
  if p_status not in ('open','paused','closed') then raise exception 'invalid_status'; end if;
  if p_status <> 'open' and coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  update stations set status = p_status, pause_reason = case when p_status = 'open' then null else p_reason end
   where id = s.id;
  insert into station_events (event_id, station_id, from_status, to_status, reason, actor_id)
  values (s.event_id, s.id, s.status, p_status, p_reason, auth.uid());
  perform public.write_audit(s.event_id, 'station.' || p_status, 'station', s.id::text, p_reason, '{}');

  if p_status <> 'open' and s.kind = 'station' then
    -- waiting tickets move to another compatible station; in-service participants are never moved
    for q in select * from queue_assignments where station_id = s.id and state in ('queued','called') order by seq loop
      update queue_assignments set state = 'reassigned', ended_at = now() where id = q.id;
      update participant_tasks set station_id = null where id = q.task_id;
      perform public._set_task_status(q.task_id, 'not_ready', 'Station ' || p_status || ': ' || p_reason, 'system', s.id);
      perform public._schedule_next(q.registration_id);
      n := n + 1;
    end loop;
  elsif p_status = 'open' then
    n := public._rebalance_waiting(s.event_id);
  end if;
  return jsonb_build_object('ok', true, 'moved', n);
end $$;

create or replace function public.assign_staff(p_station uuid, p_user uuid, p_start timestamptz, p_end timestamptz)
returns uuid language plpgsql security definer set search_path = public as $$
declare s stations; v_id uuid;
begin
  perform public._lock_event((select event_id from stations where id = p_station));
  select * into s from stations where id = p_station;
  if not found then raise exception 'not_found: station'; end if;
  perform public.require_perm(s.event_id, 'shift.assign');
  if not exists (select 1 from event_memberships where event_id = s.event_id and user_id = p_user and active) then
    raise exception 'not_member: user is not staff on this event';
  end if;
  insert into staff_assignments (event_id, user_id, station_id, shift_start, shift_end, created_by)
  values (s.event_id, p_user, s.id, p_start, p_end, auth.uid()) returning id into v_id;
  perform public.write_audit(s.event_id, 'staff.assign', 'staff_assignment', v_id::text, null,
    jsonb_build_object('station', s.code, 'user', p_user, 'start', p_start, 'end', p_end));
  perform public._rebalance_waiting(s.event_id);
  return v_id;
end $$;

create or replace function public.end_staff_assignment(p_assignment uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare a staff_assignments;
begin
  select * into a from staff_assignments where id = p_assignment for update;
  if not found then raise exception 'not_found: assignment'; end if;
  perform public.require_perm(a.event_id, 'shift.assign');
  update staff_assignments set status = 'ended', shift_end = least(shift_end, greatest(now(), shift_start + interval '1 second')),
         ended_by = auth.uid() where id = a.id;
  perform public.write_audit(a.event_id, 'staff.unassign', 'staff_assignment', a.id::text, p_reason, '{}');
end $$;

-- ---------------------------------------------------------------- tags & scanning
-- Issuing a tag always creates a new opaque token (hash only) and revokes the previous one.
create or replace function public.issue_tag(p_reg uuid, p_token_hash text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r registrations; v_kind text;
begin
  select * into r from registrations where id = p_reg for update;
  if not found then raise exception 'not_found: registration'; end if;
  if r.status <> 'active' then raise exception 'registration_inactive'; end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_token_hash'; end if;
  if r.tag_version = 0 then
    perform public.require_perm(r.event_id, 'registration.create');
    v_kind := 'original';
  else
    perform public.require_perm(r.event_id, 'tag.reprint');
    if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required: reprint reason'; end if;
    v_kind := 'reprint';
  end if;
  update registration_tokens set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'superseded by reprint'
   where registration_id = r.id and revoked_at is null;
  insert into registration_tokens (registration_id, token_hash, tag_version, created_by)
  values (r.id, p_token_hash, r.tag_version + 1, auth.uid());
  update registrations set tag_version = tag_version + 1, tag_printed_confirmed_at = null where id = r.id;
  insert into tag_prints (registration_id, tag_version, kind, reason, printed_by)
  values (r.id, r.tag_version + 1, v_kind, p_reason, auth.uid());
  perform public.write_audit(r.event_id, 'tag.' || v_kind, 'registration', r.id::text, p_reason,
    jsonb_build_object('tag_version', r.tag_version + 1));
  return jsonb_build_object('tag_version', r.tag_version + 1, 'kind', v_kind);
end $$;

create or replace function public.confirm_tag_printed(p_reg uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r registrations;
begin
  select * into r from registrations where id = p_reg;
  perform public.require_perm(r.event_id, 'registration.create');
  if r.tag_version = 0 then raise exception 'no_tag_issued'; end if;
  update registrations set tag_printed_confirmed_at = now() where id = r.id;
  perform public.write_audit(r.event_id, 'tag.confirm_printed', 'registration', r.id::text, null,
    jsonb_build_object('tag_version', r.tag_version));
end $$;

create or replace function public.revoke_tag(p_reg uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare r registrations;
begin
  select * into r from registrations where id = p_reg;
  if not found then raise exception 'not_found: registration'; end if;
  perform public.require_perm(r.event_id, 'tag.revoke');
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  update registration_tokens set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = p_reason
   where registration_id = r.id and revoked_at is null;
  delete from portal_sessions where registration_id = r.id;
  perform public.write_audit(r.event_id, 'tag.revoke', 'registration', r.id::text, p_reason, '{}');
end $$;

-- Staff scan: accepts a registration code or the hash of a portal token. Requires a staff session.
create or replace function public.resolve_scan(p_event uuid, p_code text, p_token_hash text, p_station uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_reg uuid;
begin
  if not public.has_perm(p_event, 'participant.view') then
    raise exception 'permission_denied: participant.view' using errcode = '42501';
  end if;
  if nullif(btrim(p_token_hash), '') is not null then
    select r.id into v_reg from registration_tokens k join registrations r on r.id = k.registration_id
     where k.token_hash = p_token_hash and k.revoked_at is null and r.event_id = p_event;
  else
    select id into v_reg from registrations where event_id = p_event and registration_code = upper(btrim(p_code));
  end if;
  insert into scan_events (event_id, registration_id, station_id, actor_id, result)
  values (p_event, v_reg, p_station, auth.uid(), case when v_reg is null then 'not_found' else 'found' end);
  return v_reg;
end $$;
