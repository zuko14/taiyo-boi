-- Event administration, readiness validation, dashboards and reconciliation counts.

create or replace function public.create_event(p_code text, p_name text, p_timezone text default 'Asia/Kolkata')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is not null and not public.is_platform_admin() then
    raise exception 'permission_denied: platform admin' using errcode = '42501';
  end if;
  insert into events (code, name, timezone) values (upper(btrim(p_code)), btrim(p_name), p_timezone) returning id into v_id;
  insert into role_permissions (event_id, role_code, permission_code)
  select v_id, role_code, permission_code from default_role_permissions;
  perform public.write_audit(v_id, 'event.create', 'event', v_id::text, null, jsonb_build_object('code', p_code));
  return v_id;
end $$;

-- Initial package templates from the client brochure (10 Nov 2026). Everything created here
-- is ordinary editable configuration. Service grouping is PROVISIONAL until the Lab Partner
-- approves it (events.settings.grouping_approved). Shorthand B2/BT2/D is preserved verbatim.
create or replace function public.apply_brochure_template(p_event uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_f uuid; v_m uuid; v_usg uuid; v_cg uuid;
begin
  if auth.uid() is not null and not public.is_platform_admin() then
    raise exception 'permission_denied: platform admin' using errcode = '42501';
  end if;
  if exists (select 1 from packages where event_id = p_event) then raise exception 'template_already_applied'; end if;

  insert into workflow_services (event_id, code, name, location, instructions) values
    (p_event, 'SAMPLE', 'Sample collection (provisional grouping)', 'event_day', 'Grouping awaiting Lab Partner approval'),
    (p_event, 'ECG', 'ECG', 'event_day', ''),
    (p_event, 'XRAY', 'X-Ray', 'event_day', ''),
    (p_event, 'BMD', 'BMD', 'event_day', ''),
    (p_event, 'BODYCOMP', 'Body Composition', 'event_day', ''),
    (p_event, 'USG', 'USG screening', 'walk_in', 'Performed at the walk-in centre');

  insert into test_catalog (event_id, code, display_name, source_wording, location) values
    (p_event, 'CBC', 'CBC', 'CBC', 'event_day'),
    (p_event, 'T3', 'T3', 'T3', 'event_day'),
    (p_event, 'T4', 'T4', 'T4', 'event_day'),
    (p_event, 'TSH', 'TSH', 'TSH', 'event_day'),
    (p_event, 'TFT', 'TFT', 'TFT', 'event_day'),
    (p_event, 'LFT', 'LFT', 'LFT', 'event_day'),
    (p_event, 'B2-BT2', 'B2, BT2', 'B2, BT2', 'event_day'),
    (p_event, 'D', 'D', 'D', 'event_day'),
    (p_event, 'CA-125', 'CA-125', 'CA-125', 'event_day'),
    (p_event, 'PSA', 'PSA', 'PSA', 'event_day'),
    (p_event, 'CALCIUM', 'Calcium', 'Calcium', 'event_day'),
    (p_event, 'LIPID', 'Lipid', 'Lipid', 'event_day'),
    (p_event, 'HBA1C', 'HbA1c', 'HbA1c', 'event_day'),
    (p_event, 'BMD', 'BMD', 'BMD', 'event_day'),
    (p_event, 'ECG', 'ECG', 'ECG', 'event_day'),
    (p_event, 'XRAY', 'X-Ray', 'X-Ray', 'event_day'),
    (p_event, 'BODYCOMP', 'Body Composition', 'Body Composition', 'event_day'),
    (p_event, 'USG-THYROID', 'USG screening – Thyroid', 'USG screening – Thyroid', 'walk_in'),
    (p_event, 'USG-BREAST', 'USG screening – Breast', 'USG screening – Thyroid/Breast', 'walk_in');

  insert into workflow_service_tests (event_id, service_id, test_id)
  select p_event, s.id, t.id from test_catalog t
    join workflow_services s on s.event_id = p_event and s.code = case
      when t.code in ('ECG','XRAY','BMD','BODYCOMP') then t.code
      when t.code like 'USG-%' then 'USG' else 'SAMPLE' end
   where t.event_id = p_event;

  insert into packages (event_id, classification, code, name, code_letter, eligibility_note)
  values (p_event, 'female', 'FEMALE', 'Exclusive Wellness Package (Female)', 'F', 'Female classification (client brochure)')
  returning id into v_f;
  insert into packages (event_id, classification, code, name, code_letter, eligibility_note)
  values (p_event, 'male', 'MALE', 'Exclusive Wellness Package (Male)', 'M', 'Male classification (client brochure)')
  returning id into v_m;

  insert into package_tests (event_id, package_id, test_id)
  select p_event, v_f, id from test_catalog where event_id = p_event and code in
    ('CBC','T3','T4','TSH','LFT','B2-BT2','D','CA-125','CALCIUM','LIPID','HBA1C','BMD','ECG','BODYCOMP');
  insert into package_tests (event_id, package_id, test_id)
  select p_event, v_m, id from test_catalog where event_id = p_event and code in
    ('CBC','TFT','LFT','B2-BT2','D','PSA','CALCIUM','HBA1C','LIPID','BMD','ECG','XRAY','BODYCOMP','USG-THYROID');

  select id into v_usg from workflow_services where event_id = p_event and code = 'USG';
  insert into choice_groups (event_id, package_id, code, name, source_wording, rule, service_id)
  values (p_event, v_f, 'USG-CHOICE', 'USG screening (Thyroid or Breast)', 'USG screening – Thyroid/Breast', 'one_of', v_usg)
  returning id into v_cg;
  insert into package_tests (event_id, package_id, test_id, choice_group_id)
  select p_event, v_f, id, v_cg from test_catalog where event_id = p_event and code in ('USG-THYROID','USG-BREAST');

  -- backend-only reference rates (never rendered); settlement unit unconfirmed
  insert into sponsor_backend_rates (event_id, classification, amount_paise, note) values
    (p_event, 'female', 299900, 'Client brochure rate; sponsor-to-lab, not an employee charge'),
    (p_event, 'male', 199900, 'Client brochure rate; sponsor-to-lab, not an employee charge');

  update events set settings = settings || '{"grouping_approved": false}'::jsonb where id = p_event;
end $$;

create or replace function public.validate_event(p_event uuid)
returns table (level text, message text)
language plpgsql stable security definer set search_path = public as $$
declare e events;
begin
  perform public.require_perm(p_event, 'dashboard.view');
  select * into e from events where id = p_event;
  return query
  with chk(level, message) as (
    select 'error', 'Missing ' || c || ' package' from unnest(array['female','male']) c
     where not exists (select 1 from packages p where p.event_id = p_event and p.classification = c and p.active)
    union all
    select 'error', 'Package "' || p.name || '" has no tests' from packages p
     where p.event_id = p_event and not exists (select 1 from package_tests pt where pt.package_id = p.id)
    union all
    select 'error', 'Test "' || t.display_name || '" in ' || p.name || ' has no workflow service mapping'
      from package_tests pt join test_catalog t on t.id = pt.test_id join packages p on p.id = pt.package_id
     where pt.event_id = p_event and pt.choice_group_id is null
       and not exists (select 1 from workflow_service_tests w where w.test_id = t.id)
    union all
    select 'error', 'Test "' || t.display_name || '" is ' || t.location || ' but its service "' || s.name || '" is ' || s.location
      from workflow_service_tests w join test_catalog t on t.id = w.test_id join workflow_services s on s.id = w.service_id
     where w.event_id = p_event and t.location <> s.location
    union all
    select 'warning', 'Package test "' || t.display_name || '" is inactive or archived'
      from package_tests pt join test_catalog t on t.id = pt.test_id
     where pt.event_id = p_event and (not t.active or t.archived)
    union all
    select 'error', 'Event-day service "' || s.name || '" has no compatible diagnostic station'
      from workflow_services s where s.event_id = p_event and s.active and s.location = 'event_day'
       and not exists (select 1 from station_capabilities sc join stations st on st.id = sc.station_id
                        where sc.service_id = s.id and st.kind = 'station')
    union all
    select 'error', 'Walk-in service "' || s.name || '" has no walk-in centre'
      from workflow_services s where s.event_id = p_event and s.active and s.location = 'walk_in'
       and not exists (select 1 from station_capabilities sc join stations st on st.id = sc.station_id
                        where sc.service_id = s.id and st.kind = 'walkin_centre')
    union all
    select 'error', 'Station "' || st.name || '" (' || st.kind || ') is mapped to ' || s.location || ' service "' || s.name || '"'
      from station_capabilities sc join stations st on st.id = sc.station_id join workflow_services s on s.id = sc.service_id
     where sc.event_id = p_event and ((st.kind = 'station' and s.location <> 'event_day')
                                   or (st.kind = 'walkin_centre' and s.location <> 'walk_in')
                                   or st.kind in ('registration_counter','addon_desk'))
    union all
    select 'error', 'Choice group "' || g.name || '" has fewer than one option'
      from choice_groups g where g.event_id = p_event
       and (select count(*) from package_tests pt where pt.choice_group_id = g.id) < 1
    union all
    select 'warning', 'Service "' || s.name || '" has no open, staffed station right now'
      from workflow_services s where s.event_id = p_event and s.active and s.location = 'event_day'
       and not exists (select 1 from station_capabilities sc join stations st on st.id = sc.station_id
                        join staff_assignments a on a.station_id = st.id and a.status = 'active'
                         and now() between a.shift_start and a.shift_end
                        where sc.service_id = s.id and st.status = 'open')
    union all
    select 'warning', 'Station "' || st.name || '" has no active staff shift'
      from stations st where st.event_id = p_event
       and not exists (select 1 from staff_assignments a where a.station_id = st.id and a.status = 'active' and a.shift_end > now())
    union all
    select 'error', 'No registration counter configured'
     where not exists (select 1 from stations where event_id = p_event and kind = 'registration_counter')
    union all
    select 'warning', 'Add-on test "' || t.display_name || '" has no active price'
      from test_catalog t where t.event_id = p_event and t.addon_available and t.active
       and not exists (select 1 from addon_prices a where a.test_id = t.id and a.active
                         and (a.effective_to is null or a.effective_to > now()))
    union all
    select 'warning', 'Walk-in centre "' || st.name || '" has no address / hours (confirm with Lab Partner)'
      from stations st where st.event_id = p_event and st.kind = 'walkin_centre'
       and (st.address = '' or st.operating_hours = '')
    union all
    select 'warning', 'Lab Partner display/legal name not confirmed' where e.lab_partner_name = ''
    union all
    select 'warning', 'Workflow service grouping not yet approved by the Lab Partner (settings.grouping_approved)'
     where not coalesce((e.settings->>'grouping_approved')::boolean, false)
    union all
    select 'warning', 'No payment methods configured: add-on payments cannot be verified'
     where jsonb_array_length(coalesce(e.settings->'payment_methods', '[]')) = 0
  )
  select chk.level, chk.message from chk order by chk.level, chk.message;
end $$;

create or replace function public.set_event_status(p_event uuid, p_status text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_from text; v_errors int;
begin
  perform public._lock_event(p_event);
  perform public.require_perm(p_event, 'event.configure');
  select status into v_from from events where id = p_event for update;
  if p_status not in ('draft','ready','live','paused','closed','archived') then raise exception 'invalid_status'; end if;
  if p_status in ('ready','live') then
    select count(*) into v_errors from public.validate_event(p_event) v where v.level = 'error';
    if v_errors > 0 then raise exception 'not_ready: % configuration error(s) must be fixed first', v_errors; end if;
  end if;
  if v_from in ('live','paused') and coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  perform set_config('app.reason', coalesce(p_reason, ''), true);
  update events set status = p_status where id = p_event;
  if p_status = 'live' then perform public._rebalance_waiting(p_event); end if;
end $$;

-- ---------------------------------------------------------------- read models
create or replace view public.registration_overview with (security_invoker = true) as
select r.id, r.event_id, r.registration_code, r.classification, r.status, r.created_at, r.arrived_at,
       r.tag_version, r.tag_printed_confirmed_at, r.package_id, r.counter_station_id, r.created_by,
       p.full_name, p.name_search, p.employee_id, p.mobile, p.age, pk.name as package_name,
       count(t.id) filter (where t.location = 'event_day' and t.source = 'package' and t.status <> 'cancelled') as ed_total,
       count(t.id) filter (where t.location = 'event_day' and t.source = 'package' and t.status in ('completed','skipped')) as ed_done,
       count(t.id) filter (where t.location = 'walk_in' and t.source = 'package' and t.status <> 'cancelled') as wi_total,
       count(t.id) filter (where t.location = 'walk_in' and t.source = 'package' and t.status = 'completed') as wi_done,
       count(t.id) filter (where t.source = 'addon' and t.status <> 'cancelled') as addon_tasks,
       bool_or(t.status in ('exception','no_show')) as has_exception,
       (select s.name || ' · ' || q.state from queue_assignments q join stations s on s.id = q.station_id
         where q.registration_id = r.id and q.state in ('queued','called','in_service') limit 1) as current_step,
       (select string_agg(distinct i.status, ',') from payment_intents i where i.registration_id = r.id and i.status <> 'cancelled') as payment_states,
       (select count(*) from reports rp where rp.registration_id = r.id and rp.status = 'published') as reports_published
  from registrations r
  join participants p on p.id = r.participant_id
  join packages pk on pk.id = r.package_id
  left join participant_tasks t on t.registration_id = r.id
 group by r.id, p.id, pk.id;

create or replace function public.dashboard_overview(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb; v_fin boolean;
begin
  perform public.require_perm(p_event, 'dashboard.view');
  v_fin := public.has_perm(p_event, 'finance.view') or public.has_perm(p_event, 'payment.view');
  select jsonb_build_object(
    'registrations', (select jsonb_build_object(
        'total', count(*), 'female', count(*) filter (where classification = 'female'),
        'male', count(*) filter (where classification = 'male'),
        'arrived', count(*) filter (where arrived_at is not null),
        'last_hour', count(*) filter (where created_at > now() - interval '1 hour'))
      from registrations where event_id = p_event and status = 'active'),
    'by_counter', coalesce((select jsonb_agg(x order by x->>'name') from (
        select jsonb_build_object('name', s.name, 'count', count(*)) x
          from registrations r join stations s on s.id = r.counter_station_id
         where r.event_id = p_event and r.status = 'active' group by s.name) q), '[]'),
    'by_staff', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('name', sp.full_name, 'count', count(*)) x
          from registrations r join staff_profiles sp on sp.user_id = r.created_by
         where r.event_id = p_event and r.status = 'active' group by sp.full_name order by count(*) desc) q), '[]'),
    'tasks', coalesce((select jsonb_object_agg(k, n) from (
        select t.location || ':' || t.status as k, count(*) as n from participant_tasks t
          join registrations r on r.id = t.registration_id and r.status = 'active'
         where t.event_id = p_event group by 1) q), '{}'),
    'stations', coalesce((select jsonb_agg(x order by x->>'kind', x->>'code') from (
        select jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name, 'kind', s.kind, 'status', s.status,
          'pause_reason', s.pause_reason,
          'staff', (select count(distinct a.user_id) from staff_assignments a where a.station_id = s.id
                     and a.status = 'active' and now() between a.shift_start and a.shift_end),
          'queued', (select count(*) from queue_assignments q where q.station_id = s.id and q.state in ('queued','called')),
          'in_service', (select count(*) from queue_assignments q where q.station_id = s.id and q.state = 'in_service'),
          'completed', (select count(*) from queue_assignments q where q.station_id = s.id and q.state = 'completed'),
          'services', (select string_agg(ws.name, ', ' order by ws.name) from station_capabilities sc
                        join workflow_services ws on ws.id = sc.service_id where sc.station_id = s.id),
          'est_wait', round((select count(*) from queue_assignments q where q.station_id = s.id
                             and q.state in ('queued','called','in_service'))
                     * coalesce(s.avg_service_minutes, (public.event_setting(p_event, 'default_service_minutes'))::int, 5)::numeric
                     / greatest(1, least(s.capacity, (select count(distinct a.user_id) from staff_assignments a
                        where a.station_id = s.id and a.status = 'active' and now() between a.shift_start and a.shift_end))), 0)
        ) x from stations s where s.event_id = p_event) q), '[]'),
    'waiting_unassigned', (select count(distinct t.registration_id) from participant_tasks t
        where t.event_id = p_event and t.status = 'waiting_unassigned'),
    'awaiting_choice', (select count(*) from participant_tasks t join registrations r on r.id = t.registration_id
        where t.event_id = p_event and t.status = 'awaiting_choice' and r.status = 'active'),
    'payments', case when v_fin then (select jsonb_build_object(
        'orders', (select count(*) from orders where event_id = p_event and kind = 'addon'),
        'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from payment_intents
                      where event_id = p_event group by status) q), '{}'),
        'received_paise', coalesce((select sum(amount_paise) from payment_transactions where event_id = p_event and status = 'verified'), 0)
                        - coalesce((select sum(amount_paise) from refunds where event_id = p_event), 0))) end,
    'reports', jsonb_build_object(
        'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from reports
                      where event_id = p_event group by status) q), '{}'),
        'lines_without_report', (select count(*) from order_items oi join registrations r on r.id = oi.registration_id
                      where oi.event_id = p_event and oi.status = 'active' and r.status = 'active'
                        and not exists (select 1 from reports rp where rp.order_item_id = oi.id
                                        and rp.status in ('published','validated','uploaded_pending_validation'))),
        'unmatched_imports', (select count(*) from report_import_jobs where event_id = p_event and status = 'unmatched')),
    'alerts', coalesce((select jsonb_agg(a) from (
        select jsonb_build_object('level', 'error', 'text', 'Station ' || s.name || ' is open but has no staff on shift') a
          from stations s where s.event_id = p_event and s.status = 'open' and s.kind <> 'walkin_centre'
           and not exists (select 1 from staff_assignments x where x.station_id = s.id and x.status = 'active'
                           and now() between x.shift_start and x.shift_end)
        union all
        select jsonb_build_object('level', 'warning', 'text', count(distinct t.registration_id) || ' participant(s) waiting with no compatible station')
          from participant_tasks t where t.event_id = p_event and t.status = 'waiting_unassigned' having count(*) > 0
        union all
        select jsonb_build_object('level', 'warning', 'text', count(*) || ' payment(s) need review')
          from payment_intents where event_id = p_event and status = 'requires_review' having count(*) > 0
        union all
        select jsonb_build_object('level', 'warning', 'text', count(*) || ' report(s) need review (mapping mismatch)')
          from reports where event_id = p_event and status = 'requires_review' having count(*) > 0
        union all
        select jsonb_build_object('level', 'warning', 'text', count(*) || ' task exception(s) need supervisor action')
          from participant_tasks where event_id = p_event and status = 'exception' having count(*) > 0
        union all
        select jsonb_build_object('level', 'warning', 'text', count(*) || ' repeated scan(s) of unknown codes in the last hour')
          from scan_events where event_id = p_event and result = 'not_found' and created_at > now() - interval '1 hour'
          having count(*) > 2) q), '[]')
  ) into v;
  return v;
end $$;

-- Per-test attendance counts (no money). Usable by operations and the sponsor viewer.
create or replace function public.test_attendance(p_event uuid, p_source text default 'package')
returns table (classification text, test_code text, test_name text, location text, expected bigint,
               appeared bigint, completed bigint, pending bigint, no_show bigint, skipped bigint,
               exception bigint, walkin_outstanding bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.has_perm(p_event, 'dashboard.view') or public.has_perm(p_event, 'sponsor.view')) then
    raise exception 'permission_denied: sponsor.view' using errcode = '42501';
  end if;
  return query
  select r.classification, oi.test_code, oi.test_name, oi.location,
         count(*),
         count(*) filter (where exists (select 1 from task_attendance_events a where a.order_item_id = oi.id and a.kind = 'appeared')),
         count(*) filter (where exists (select 1 from task_attendance_events a where a.order_item_id = oi.id and a.kind = 'completed')),
         count(*) filter (where t.status in ('not_ready','waiting_unassigned','queued','called','in_service','not_attended','checked_in')),
         count(*) filter (where t.status = 'no_show'),
         count(*) filter (where t.status = 'skipped'),
         count(*) filter (where t.status = 'exception'),
         count(*) filter (where oi.location = 'walk_in' and t.status not in ('completed','cancelled'))
    from order_items oi
    join registrations r on r.id = oi.registration_id and r.status = 'active'
    left join lateral (select pt.status from task_items ti join participant_tasks pt on pt.id = ti.task_id
                        where ti.order_item_id = oi.id order by pt.created_at desc limit 1) t on true
   where oi.event_id = p_event and oi.source = p_source and oi.status = 'active'
   group by r.classification, oi.test_code, oi.test_name, oi.location
   order by r.classification, oi.location, oi.test_name;
end $$;

create or replace function public.sponsor_summary(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.has_perm(p_event, 'dashboard.view') or public.has_perm(p_event, 'sponsor.view')) then
    raise exception 'permission_denied: sponsor.view' using errcode = '42501';
  end if;
  return (select jsonb_agg(jsonb_build_object(
      'classification', c,
      'registered', (select count(*) from registrations where event_id = p_event and status = 'active' and classification = c),
      'appeared', (select count(*) from registrations where event_id = p_event and status = 'active' and classification = c and arrived_at is not null),
      'with_package_attendance', (select count(distinct a.registration_id) from task_attendance_events a
           join registrations r on r.id = a.registration_id
          where a.event_id = p_event and a.source = 'package' and a.kind = 'appeared' and r.status = 'active' and r.classification = c),
      'all_package_lines_completed', (select count(*) from registrations r where r.event_id = p_event and r.status = 'active'
           and r.classification = c and not exists (
             select 1 from order_items oi where oi.registration_id = r.id and oi.source = 'package' and oi.status = 'active'
              and not exists (select 1 from task_attendance_events a where a.order_item_id = oi.id and a.kind = 'completed'))
           and not exists (select 1 from participant_tasks t where t.registration_id = r.id and t.status = 'awaiting_choice')),
      'adjustments', (select count(*) from audit_logs l where l.event_id = p_event
           and l.action in ('task.skip','task.cancel','task.requeue','registration.duplicate_resolve','registration.config_migrate'))
    ) order by c) from unnest(array['female','male']) c);
end $$;

create or replace function public.addon_revenue(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_perm(p_event, 'finance.view');
  return jsonb_build_object(
    'by_test', coalesce((select jsonb_agg(x order by x->>'name') from (
      select jsonb_build_object('code', oi.test_code, 'name', oi.test_name,
        'quantity', sum(oi.quantity),
        'unit_prices', array_agg(distinct oi.unit_price_paise),
        'gross_paise', sum((oi.unit_price_paise + oi.tax_paise) * oi.quantity),
        'tax_paise', sum(oi.tax_paise * oi.quantity),
        'paid_paise', sum((oi.unit_price_paise + oi.tax_paise) * oi.quantity) filter (where i.status in ('paid','partially_refunded','refunded')),
        'pending_paise', sum((oi.unit_price_paise + oi.tax_paise) * oi.quantity) filter (where i.status in ('pending','requires_review')),
        'failed_paise', sum((oi.unit_price_paise + oi.tax_paise) * oi.quantity) filter (where i.status = 'failed'),
        'waived_paise', sum((oi.unit_price_paise + oi.tax_paise) * oi.quantity) filter (where i.status = 'waived')) x
        from order_items oi join orders o on o.id = oi.order_id
        left join payment_intents i on i.order_id = o.id
       where oi.event_id = p_event and oi.source = 'addon' and o.status = 'active'
       group by oi.test_code, oi.test_name) q), '[]'),
    'totals', jsonb_build_object(
      'verified_received_paise', coalesce((select sum(amount_paise) from payment_transactions where event_id = p_event and status = 'verified'), 0),
      'refunded_paise', coalesce((select sum(amount_paise) from refunds where event_id = p_event), 0),
      'pending_paise', coalesce((select sum(amount_paise) from payment_intents where event_id = p_event and status in ('pending','requires_review')), 0),
      'failed_paise', coalesce((select sum(amount_paise) from payment_intents where event_id = p_event and status = 'failed'), 0),
      'waived_paise', coalesce((select sum(amount_paise) from payment_intents where event_id = p_event and status = 'waived'), 0)),
    'by_method', coalesce((select jsonb_agg(jsonb_build_object('method', method, 'count', n, 'amount_paise', amt)) from (
      select method, count(*) n, sum(amount_paise) amt from payment_transactions
       where event_id = p_event and status = 'verified' group by method) q), '[]'),
    'by_cashier', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'count', n, 'amount_paise', amt)) from (
      select coalesce(sp.full_name, 'unknown') name, count(*) n, sum(pt.amount_paise) amt from payment_transactions pt
        left join staff_profiles sp on sp.user_id = pt.verified_by
       where pt.event_id = p_event and pt.status = 'verified' group by 1) q), '[]'));
end $$;

create or replace function public.staff_directory(p_event uuid)
returns table (user_id uuid, full_name text, email text, roles text[])
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.has_perm(p_event, 'staff.manage') or public.has_perm(p_event, 'shift.assign')
          or public.has_perm(p_event, 'permissions.manage')) then
    raise exception 'permission_denied: staff.manage' using errcode = '42501';
  end if;
  return query select sp.user_id, sp.full_name, sp.email, array_agg(m.role_code order by m.role_code)
    from event_memberships m join staff_profiles sp on sp.user_id = m.user_id
   where m.event_id = p_event and m.active group by sp.user_id order by sp.full_name;
end $$;
