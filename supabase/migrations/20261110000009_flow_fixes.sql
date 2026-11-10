-- Flow fixes found in the end-to-end audit (10 Nov 2026). Functions are redefined in full.
-- 1. create_addon_order: add-on lines keep the service's completion rule.
-- 2. task_action: completing a visit also completes the participant's other eligible (paid)
--    tasks for the same service, so an add-on in the same encounter is not a second queue visit.
-- 3. payment_action: cancelling an add-on also ends its queue ticket (no orphan assignment).
-- 4. confirm_order_item: locked, station-checked, active lines only.
-- 5. end_staff_assignment: an unstaffed station's waiting tickets move to a staffed station.
-- 6. claim_task: a technician can serve a participant queued at another compatible station.

create or replace function public.create_addon_order(
  p_reg uuid, p_desk uuid, p_test_ids uuid[], p_idempotency_key text, p_consent boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r registrations; s stations; v_snap jsonb; v_order uuid; v_intent uuid; v_total bigint;
  v_existing orders; grp record; v_task uuid; v_bad text;
begin
  perform public._lock_event((select event_id from registrations where id = p_reg));
  select * into r from registrations where id = p_reg;
  if not found or r.status <> 'active' then raise exception 'registration_inactive'; end if;
  s := public.assert_on_duty(p_desk, array['addon_desk']);
  if s.event_id <> r.event_id then raise exception 'invalid_station'; end if;
  perform public.require_perm(r.event_id, 'addon.create');
  perform public.assert_event_live(r.event_id);
  if coalesce(btrim(p_idempotency_key), '') = '' then raise exception 'idempotency_key_required'; end if;

  select * into v_existing from orders where registration_id = r.id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('order_id', v_existing.id, 'already', true,
      'intent_id', (select id from payment_intents where order_id = v_existing.id));
  end if;
  if not coalesce(p_consent, false) then raise exception 'consent_required: participant must confirm the tests and price'; end if;
  if coalesce(array_length(p_test_ids, 1), 0) = 0 then raise exception 'no_tests_selected'; end if;

  select snapshot into v_snap from package_configuration_versions where id = r.package_version_id;

  create temp table if not exists _addon_lines (test_id uuid, code text, name text, location text,
    price bigint, tax bigint, require_payment boolean, service_id uuid, rule text) on commit drop;
  delete from _addon_lines where true;
  insert into _addon_lines
  select t.id, t.code, t.display_name, t.location, ap.price_paise, ap.tax_paise,
         ap.require_payment_before_service, wst.service_id,
         coalesce(wst.completion_rule, 'fulfilled_on_complete')
    from (select distinct unnest(p_test_ids) as id) x
    join test_catalog t on t.id = x.id and t.event_id = r.event_id
    left join lateral (select * from addon_prices a
                        where a.test_id = t.id and a.active and a.effective_from <= now()
                          and (a.effective_to is null or a.effective_to > now())
                          and (a.location_scope = 'both' or a.location_scope = t.location)
                        order by a.effective_from desc limit 1) ap on true
    left join workflow_service_tests wst on wst.test_id = t.id;

  if (select count(*) from _addon_lines) <> (select count(distinct x) from unnest(p_test_ids) x) then
    raise exception 'invalid_test';
  end if;
  select string_agg(l.name, ', ') into v_bad from _addon_lines l
   where exists (select 1 from jsonb_array_elements(v_snap->'tests') y where (y->>'test_id')::uuid = l.test_id);
  if v_bad is not null then raise exception 'included_in_package: % already included in the sponsored package', v_bad; end if;
  select string_agg(l.name, ', ') into v_bad from _addon_lines l join test_catalog t on t.id = l.test_id
   where not t.active or t.archived or not t.addon_available;
  if v_bad is not null then raise exception 'not_available_as_addon: %', v_bad; end if;
  select string_agg(name, ', ') into v_bad from _addon_lines where price is null;
  if v_bad is not null then raise exception 'price_missing: %', v_bad; end if;
  select string_agg(name, ', ') into v_bad from _addon_lines where service_id is null;
  if v_bad is not null then raise exception 'config_invalid: no workflow service for %', v_bad; end if;
  select string_agg(l.name, ', ') into v_bad from _addon_lines l
   where exists (select 1 from order_items oi join orders o on o.id = oi.order_id
                  where oi.registration_id = r.id and oi.test_id = l.test_id and oi.status = 'active'
                    and o.status = 'active');
  if v_bad is not null then raise exception 'already_ordered: %', v_bad; end if;

  select sum(price + tax) into v_total from _addon_lines;
  insert into orders (event_id, registration_id, kind, total_paise, idempotency_key, consent_at, desk_station_id, created_by)
  values (r.event_id, r.id, 'addon', v_total, p_idempotency_key, now(), s.id, auth.uid()) returning id into v_order;
  if v_total > 0 then
    insert into payment_intents (event_id, order_id, registration_id, amount_paise, created_by)
    values (r.event_id, v_order, r.id, v_total, auth.uid()) returning id into v_intent;
  end if;

  for grp in
    select l.service_id, l.location, bool_or(l.require_payment) as req, ws.name as svc_name, ws.priority
      from _addon_lines l join workflow_services ws on ws.id = l.service_id
     group by l.service_id, l.location, ws.name, ws.priority
  loop
    insert into participant_tasks (event_id, registration_id, service_id, service_name, location, source,
                                   status, priority, payment_intent_id)
    values (r.event_id, r.id, grp.service_id, grp.svc_name, grp.location, 'addon',
            case grp.location when 'walk_in' then 'not_attended' else 'not_ready' end, grp.priority,
            case when grp.req and v_intent is not null then v_intent end)
    returning id into v_task;
    with ins as (
      insert into order_items (event_id, order_id, registration_id, test_id, test_code, test_name, location,
                               source, responsibility, unit_price_paise, tax_paise, completion_rule)
      select r.event_id, v_order, r.id, test_id, code, name, location, 'addon', 'employee', price, tax, rule
        from _addon_lines where service_id = grp.service_id and location = grp.location
      returning id)
    insert into task_items (task_id, order_item_id) select v_task, id from ins;
    insert into task_status_history (event_id, task_id, to_status, actor_id, source)
    select r.event_id, v_task, status, auth.uid(), 'addon' from participant_tasks where id = v_task;
  end loop;

  perform public.write_audit(r.event_id, 'addon.create', 'order', v_order::text, null,
    jsonb_build_object('total_paise', v_total, 'tests', (select jsonb_agg(code) from _addon_lines)));
  perform public._schedule_next(r.id);
  return jsonb_build_object('order_id', v_order, 'intent_id', v_intent, 'total_paise', v_total, 'already', false);
end $$;

create or replace function public.task_action(p_task uuid, p_action text, p_station uuid default null,
                                              p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t participant_tasks; v_target text; v_allowed text[]; v_perm text; v_need_reason boolean := false;
  v_qa queue_assignments; v_next uuid; v_visit uuid; v_tz text; v_sib participant_tasks;
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
  if v_target = 'completed' and t.location = 'event_day' then
    -- same encounter: other eligible (paid, unblocked) tasks for this service are done in this visit
    for v_sib in select * from participant_tasks s
                  where s.registration_id = t.registration_id and s.id <> t.id and s.service_id = t.service_id
                    and s.location = 'event_day' and public._task_eligible(s) for update loop
      update participant_tasks set station_id = p_station, completed_at = now(), completed_by = auth.uid()
       where id = v_sib.id;
      perform public._record_attendance(v_sib.id, 'appeared');
      perform public._record_attendance(v_sib.id, 'completed');
      perform public._set_task_status(v_sib.id, 'completed', 'Completed in the same visit', 'user', p_station);
      perform public.write_audit(t.event_id, 'task.complete', 'participant_task', v_sib.id::text,
        'Completed in the same visit', jsonb_build_object('with_task', t.id, 'station', p_station));
    end loop;
  end if;
  perform public.write_audit(t.event_id, 'task.' || p_action, 'participant_task', t.id::text, p_reason,
    jsonb_build_object('from', t.status, 'to', v_target, 'station', p_station));

  if t.location = 'event_day' and v_target in ('completed','no_show','exception','skipped','cancelled','not_ready') then
    v_next := public._schedule_next(t.registration_id);
  end if;
  return jsonb_build_object('ok', true, 'status', v_target, 'next_assignment', v_next);
end $$;

create or replace function public.payment_action(p_intent uuid, p_action text, p_reason text,
                                                 p_amount_paise bigint default null, p_provider_ref text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i payment_intents; v_new text; v_paid bigint;
begin
  perform public._lock_event((select event_id from payment_intents where id = p_intent));
  select * into i from payment_intents where id = p_intent for update;
  if not found then raise exception 'not_found: payment'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  perform set_config('app.reason', p_reason, true);

  if p_action = 'fail' then
    perform public.require_perm(i.event_id, 'payment.verify');
    if i.status not in ('pending','requires_review') then raise exception 'illegal_transition: payment is %', i.status; end if;
    insert into payment_transactions (event_id, intent_id, method, amount_paise, status, note, verified_by)
    values (i.event_id, i.id, 'n/a', 0, 'failed', p_reason, auth.uid());
    v_new := 'failed';
  elsif p_action = 'cancel' then
    perform public.require_perm(i.event_id, 'addon.create');
    if i.status not in ('pending','failed','requires_review') then
      raise exception 'illegal_transition: paid add-ons must be refunded, not cancelled';
    end if;
    v_new := 'cancelled';
  elsif p_action = 'reopen' then
    perform public.require_perm(i.event_id, 'payment.verify');
    if i.status not in ('failed','requires_review') then raise exception 'illegal_transition: payment is %', i.status; end if;
    v_new := 'pending';
  elsif p_action = 'waive' then
    perform public.require_perm(i.event_id, 'payment.waive');
    if i.status not in ('pending','requires_review','failed') then raise exception 'illegal_transition: payment is %', i.status; end if;
    v_new := 'waived';
  elsif p_action = 'refund' then
    perform public.require_perm(i.event_id, 'payment.refund');
    if i.status not in ('paid','partially_refunded') then raise exception 'illegal_transition: payment is %', i.status; end if;
    if p_amount_paise is null or p_amount_paise <= 0 or p_amount_paise > i.amount_paise - i.refunded_paise then
      raise exception 'invalid_amount';
    end if;
    insert into refunds (event_id, intent_id, amount_paise, reason, provider_ref, actor_id)
    values (i.event_id, i.id, p_amount_paise, p_reason, nullif(btrim(p_provider_ref), ''), auth.uid());
    v_paid := i.refunded_paise + p_amount_paise;
    update payment_intents set refunded_paise = v_paid where id = i.id;
    v_new := case when v_paid = i.amount_paise then 'refunded' else 'partially_refunded' end;
  else
    raise exception 'invalid_action';
  end if;

  update payment_intents set status = v_new, status_reason = p_reason, updated_at = now() where id = i.id;
  -- cancelled / fully refunded add-ons: unstarted tasks are cancelled; performed work stays recorded
  if v_new in ('cancelled','refunded') then
    update order_items set status = 'cancelled' where order_id = i.order_id and status = 'active'
       and not exists (select 1 from task_items ti join participant_tasks t on t.id = ti.task_id
                        where ti.order_item_id = order_items.id and t.status in ('in_service','completed','checked_in'));
    -- tasks of this order that are unstarted and now have no active line left
    create temp table if not exists _dead_tasks (id uuid) on commit drop;
    delete from _dead_tasks where true;
    insert into _dead_tasks
    select t.id from participant_tasks t
     where t.registration_id = i.registration_id
       and t.status in ('not_ready','waiting_unassigned','queued','called','not_attended')
       and exists (select 1 from task_items ti join order_items oi on oi.id = ti.order_item_id
                    where ti.task_id = t.id and oi.order_id = i.order_id)
       and not exists (select 1 from task_items ti join order_items oi on oi.id = ti.order_item_id
                        where ti.task_id = t.id and oi.status = 'active');
    update queue_assignments set state = 'cancelled', ended_at = now()
     where task_id in (select id from _dead_tasks) and state in ('queued','called');
    update participant_tasks set station_id = null where id in (select id from _dead_tasks);
    perform public._set_task_status(d.id, 'cancelled', 'Add-on ' || v_new || ': ' || p_reason, 'system', null)
       from _dead_tasks d;
    if v_new = 'cancelled' then update orders set status = 'cancelled' where id = i.order_id; end if;
  end if;
  perform public.write_audit(i.event_id, 'payment.' || p_action, 'payment_intent', i.id::text, p_reason,
    jsonb_build_object('from', i.status, 'to', v_new, 'amount_paise', p_amount_paise));
  perform public._schedule_next(i.registration_id);
  return jsonb_build_object('ok', true, 'status', v_new);
end $$;

-- Confirm one order line inside a grouped encounter (completion_rule = manual_confirm).
create or replace function public.confirm_order_item(p_order_item uuid, p_station uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare oi order_items; t participant_tasks;
begin
  perform public._lock_event((select event_id from order_items where id = p_order_item));
  select * into oi from order_items where id = p_order_item;
  if not found then raise exception 'not_found: order item'; end if;
  select pt.* into t from participant_tasks pt join task_items ti on ti.task_id = pt.id
   where ti.order_item_id = oi.id order by pt.created_at desc limit 1;
  perform public.require_perm(oi.event_id, case t.location when 'walk_in' then 'walkin.perform' else 'task.perform' end);
  perform public.assert_on_duty(p_station, array['station','walkin_centre']);
  if oi.status <> 'active' then raise exception 'order_item_cancelled'; end if;
  if t.station_id is distinct from p_station then raise exception 'wrong_station: this test was performed at another station'; end if;
  if t.status not in ('in_service','completed') then raise exception 'illegal_transition: service not started'; end if;
  insert into task_attendance_events (event_id, registration_id, order_item_id, test_id, package_id, source, kind,
                                      task_id, station_id, actor_id)
  select oi.event_id, oi.registration_id, oi.id, oi.test_id, case when oi.source = 'package' then r.package_id end,
         oi.source, k, t.id, p_station, auth.uid()
    from registrations r, unnest(array['appeared','completed']) k where r.id = oi.registration_id
  on conflict (order_item_id, kind) do nothing;
  perform public.write_audit(oi.event_id, 'order_item.confirm', 'order_item', oi.id::text, p_reason, '{}');
end $$;

-- Ending a shift: if the station is left with nobody on duty, its waiting tickets move on.
create or replace function public.end_staff_assignment(p_assignment uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare a staff_assignments; q record;
begin
  perform public._lock_event((select event_id from staff_assignments where id = p_assignment));
  select * into a from staff_assignments where id = p_assignment for update;
  if not found then raise exception 'not_found: assignment'; end if;
  perform public.require_perm(a.event_id, 'shift.assign');
  update staff_assignments set status = 'ended', shift_end = least(shift_end, greatest(now(), shift_start + interval '1 second')),
         ended_by = auth.uid() where id = a.id;
  perform public.write_audit(a.event_id, 'staff.unassign', 'staff_assignment', a.id::text, p_reason, '{}');
  if not exists (select 1 from staff_assignments where station_id = a.station_id and status = 'active'
                   and now() between shift_start and shift_end) then
    for q in select * from queue_assignments where station_id = a.station_id and state = 'queued' order by seq loop
      update queue_assignments set state = 'reassigned', ended_at = now() where id = q.id;
      update participant_tasks set station_id = null where id = q.task_id;
      perform public._set_task_status(q.task_id, 'not_ready', 'Station has no staff on duty', 'system', a.station_id);
      perform public._schedule_next(q.registration_id);
    end loop;
  end if;
end $$;

-- A participant queued at one station turns up at another station that offers the same service.
-- The technician there can take them over (waiting tickets only; audited).
create or replace function public.claim_task(p_task uuid, p_station uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t participant_tasks; s stations; v_seq int; v_assign uuid;
begin
  perform public._lock_event((select event_id from participant_tasks where id = p_task));
  select * into t from participant_tasks where id = p_task for update;
  if not found then raise exception 'not_found: task'; end if;
  perform public.require_perm(t.event_id, 'task.perform');
  perform public.assert_event_live(t.event_id);
  s := public.assert_on_duty(p_station, array['station']);
  if s.event_id <> t.event_id then raise exception 'invalid_station'; end if;
  if t.station_id = p_station then return jsonb_build_object('ok', true, 'already', true); end if;
  if t.location <> 'event_day' or t.status not in ('queued','called') then
    raise exception 'illegal_transition: only a waiting participant can be moved (task is %)', t.status;
  end if;
  if s.status <> 'open' then raise exception 'station_unavailable: open this station first'; end if;
  update queue_assignments set state = 'reassigned', ended_at = now()
   where task_id = t.id and state in ('queued','called');
  update stations set next_seq = next_seq + 1, last_assigned_at = clock_timestamp()
   where id = s.id returning next_seq - 1 into v_seq;
  insert into queue_assignments (event_id, task_id, registration_id, station_id, seq, reason, assigned_by)
  values (t.event_id, t.id, t.registration_id, s.id, v_seq, 'Participant arrived at this station; taken over by staff', auth.uid())
  returning id into v_assign;      -- guard trigger rejects incompatible stations
  update participant_tasks set station_id = s.id where id = t.id;
  perform public._set_task_status(t.id, 'queued', 'Taken over at ' || s.code, 'user', s.id);
  perform public.write_audit(t.event_id, 'queue.claim', 'participant_task', t.id::text, null,
    jsonb_build_object('from_station', t.station_id, 'to_station', s.id));
  return jsonb_build_object('ok', true, 'assignment_id', v_assign);
end $$;

revoke execute on function public.claim_task(uuid, uuid) from public, anon;
grant execute on function public.claim_task(uuid, uuid) to authenticated;
