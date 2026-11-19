-- Stop the "No station free" state at its source. The scheduler (correctly) only sends people to
-- stations that are open AND have staff on shift now; live events could reach a state where none
-- qualified (new stations start closed; Reset closes stations and clears shifts) with only a warning.
--   1. A station that has never been opened opens automatically when its first staff shift is
--      assigned. Stations a supervisor paused/closed are never reopened automatically.
--   2. An event cannot go Live while no diagnostic station is open with staff on shift.
--   3. service_coverage(): per event-day service, which stations can serve it now and why not.

do $do$
declare d text;
begin
  d := pg_get_functiondef('public.assign_staff(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure);
  d := replace(d, $old$  perform public._rebalance_waiting(s.event_id);
  return v_id;$old$, $new$  if s.status = 'closed' and s.kind <> 'registration_counter' and s.kind <> 'addon_desk'
     and not exists (select 1 from station_events where station_id = s.id) then
    update stations set status = 'open', pause_reason = null where id = s.id;
    insert into station_events (event_id, station_id, from_status, to_status, reason, actor_id)
    values (s.event_id, s.id, 'closed', 'open', 'Opened automatically: first staff shift assigned', auth.uid());
    perform public.write_audit(s.event_id, 'station.open', 'station', s.id::text, 'Opened automatically: first staff shift assigned', '{}');
  end if;
  perform public._rebalance_waiting(s.event_id);
  return v_id;$new$);
  if position('Opened automatically: first staff shift assigned' in d) = 0 then raise exception 'assign_staff patch did not apply'; end if;
  execute d;

  d := pg_get_functiondef('public.set_event_status(uuid,text,text)'::regprocedure);
  d := replace(d, $old$must be fixed first', v_errors; end if;
  end if;$old$, $new$must be fixed first', v_errors; end if;
  end if;
  if p_status = 'live' and exists (select 1 from stations where event_id = p_event and kind = 'station')
     and not exists (
       select 1 from stations s join station_capabilities sc on sc.station_id = s.id
        where s.event_id = p_event and s.kind = 'station' and s.status = 'open' and s.accepts_assignments
          and exists (select 1 from staff_assignments a where a.station_id = s.id and a.status = 'active'
                       and now() between a.shift_start and a.shift_end)) then
    raise exception 'not_ready: no diagnostic station is open with staff on shift right now, so nobody could be assigned. Open stations and assign current shifts (Queue control / Staff & shifts) first';
  end if;$new$);
  if position('no diagnostic station is open with staff on shift' in d) = 0 then raise exception 'set_event_status patch did not apply'; end if;
  execute d;
end $do$;

-- Coverage of every active event-day service: what each compatible station is missing right now.
create or replace function public.service_coverage(p_event uuid)
returns table (service_id uuid, service_name text, station_id uuid, station_code text, station_name text,
               station_status text, accepts boolean, staff_now int, next_shift timestamptz, waiting int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_event) then raise exception 'permission_denied' using errcode = '42501'; end if;
  return query
  select w.id, w.name, s.id, s.code, s.name, s.status, s.accepts_assignments,
         (select count(distinct a.user_id)::int from staff_assignments a where a.station_id = s.id and a.status = 'active'
           and now() between a.shift_start and a.shift_end),
         (select min(a.shift_start) from staff_assignments a where a.station_id = s.id and a.status = 'active' and a.shift_start > now()),
         (select count(*)::int from participant_tasks t where t.service_id = w.id and t.status = 'waiting_unassigned')
    from workflow_services w
    left join station_capabilities sc on sc.service_id = w.id
    left join stations s on s.id = sc.station_id and s.kind = 'station'
   where w.event_id = p_event and w.active and w.location = 'event_day'
   order by w.priority, w.name, s.code;
end $$;
revoke execute on function public.service_coverage(uuid) from public, anon;
grant execute on function public.service_coverage(uuid) to authenticated;
