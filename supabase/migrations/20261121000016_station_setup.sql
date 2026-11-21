-- Station setup for any camp:
--   ensure_service: create (or reuse) a physical visit while creating a station or a test, so a new
--     camp never ends up with a station that can do nothing. Any "blood"/"sample" visit is the
--     shared SAMPLE visit (the CSV import's default), so blood tests and blood stations always meet.
--   delete_station: remove a station that never handled a participant. Anything with patient
--     history is kept (close it instead) so attendance, queue and audit evidence stay intact.

create or replace function public.ensure_service(p_event uuid, p_name text, p_location text default 'event_day') returns uuid
language plpgsql security definer set search_path = public as $$
declare v_name text := btrim(coalesce(p_name, '')); v_code text; v_id uuid; v_loc text;
begin
  if not (public.has_perm(p_event, 'station.mapping.edit') or public.has_perm(p_event, 'package.test_mapping.edit')) then
    raise exception 'permission_denied: station.mapping.edit' using errcode = '42501';
  end if;
  if v_name = '' or length(v_name) > 80 then raise exception 'invalid_code: visit name is required (max 80 characters)'; end if;
  if p_location not in ('event_day','walk_in') then raise exception 'invalid_code: location must be event_day or walk_in'; end if;
  v_code := case when p_location = 'event_day' and v_name ~* '(blood|sample)' then 'SAMPLE'
                 else left(trim(both '-' from regexp_replace(upper(v_name), '[^A-Z0-9]+', '-', 'g')), 40) end;
  if v_code = '' then raise exception 'invalid_code: visit name needs letters or digits'; end if;
  select id, location into v_id, v_loc from workflow_services where event_id = p_event and code = v_code;
  if v_id is not null then
    if v_loc <> p_location then
      raise exception 'invalid_code: a visit "%" already exists as %', v_code, replace(v_loc, '_', '-');
    end if;
    update workflow_services set active = true where id = v_id and not active;
    return v_id;
  end if;
  insert into workflow_services (event_id, code, name, location) values (p_event, v_code, v_name, p_location) returning id into v_id;
  return v_id;
end $$;

create or replace function public.delete_station(p_station uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare s stations;
begin
  select * into s from stations where id = p_station;
  if s.id is null then raise exception 'not_found: station'; end if;
  perform public._lock_event(s.event_id);
  perform public.require_perm(s.event_id, 'station.configure');
  if exists (select 1 from registrations where counter_station_id = s.id)
     or exists (select 1 from orders where desk_station_id = s.id)
     or exists (select 1 from walkin_visits where centre_id = s.id)
     or exists (select 1 from queue_assignments where station_id = s.id)
     or exists (select 1 from participant_tasks where station_id = s.id)
     or exists (select 1 from task_status_history where station_id = s.id)
     or exists (select 1 from task_attendance_events where station_id = s.id)
     or exists (select 1 from scan_events where station_id = s.id) then
    raise exception 'in_use: % has already handled participants — close it in Queue control instead (its history is kept)', s.name;
  end if;
  perform set_config('app.reason', coalesce(nullif(btrim(p_reason), ''), 'Station deleted (never used)'), true);
  perform public.write_audit(s.event_id, 'station.delete', 'station', s.id::text, p_reason,
    jsonb_build_object('code', s.code, 'name', s.name, 'kind', s.kind,
      'shifts', (select count(*) from staff_assignments where station_id = s.id)));
  delete from station_capabilities where station_id = s.id;
  delete from staff_assignments where station_id = s.id;     -- shifts at a station that never served anyone
  delete from station_events where station_id = s.id;
  delete from stations where id = s.id;
end $$;

revoke execute on function public.ensure_service(uuid, text, text), public.delete_station(uuid, text) from public, anon;
grant execute on function public.ensure_service(uuid, text, text), public.delete_station(uuid, text) to authenticated;
