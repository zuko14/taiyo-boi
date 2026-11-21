-- 1. Common names are one visit: "usg", "Ultrasound (USG)", "ultra sound", "sonography" → USG;
--    "2D Echo", "echo", "echocardiography" → 2D-ECHO; "x-ray", "xray" → X-RAY; "ecg", "ekg" → ECG.
--    (Any blood/sample name was already the shared SAMPLE visit.) Prevents a test and a station
--    meaning the same thing but never meeting.
-- 2. merge_service: fold a duplicate visit into another. Its tests move over; the target gains every
--    station that served the duplicate; the duplicate is deactivated (kept, so already-registered
--    patients' tasks can still be served there).
-- 3. station_link_tests: a station picks the exact tests it does (custom combined rooms). Tests
--    without a visit, or all of them when "one queue stop" is chosen, are linked to a visit named
--    after the station. Returns the visits the station must do.

do $do$
declare d text;
begin
  d := pg_get_functiondef('public.ensure_service(uuid,text,text)'::regprocedure);
  d := replace(d, $old$  v_code := case when p_location = 'event_day' and v_name ~* '(blood|sample)' then 'SAMPLE'$old$,
    $new$  v_code := case when p_location = 'event_day' and v_name ~* '(blood|sample)' then 'SAMPLE'
                 when v_name ~* '(ultra[ -]?sound|\musg\M|sonograph)' then 'USG'
                 when v_name ~* '(2[ -]?d[ -]?echo|echocardio|\mecho\M)' then '2D-ECHO'
                 when v_name ~* '(\mx[ -]?ray\M|\mxray\M)' then 'X-RAY'
                 when v_name ~* '(\mecg\M|\mekg\M|electrocardio)' then 'ECG'$new$);
  if position($x$then 'USG'$x$ in d) = 0 then raise exception 'ensure_service patch did not apply'; end if;
  execute d;
end $do$;

create or replace function public.merge_service(p_from uuid, p_into uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare f workflow_services; t workflow_services; n_tests int; n_stations int;
begin
  select * into f from workflow_services where id = p_from;
  select * into t from workflow_services where id = p_into;
  if f.id is null or t.id is null or f.event_id <> t.event_id then raise exception 'not_found: visit'; end if;
  perform public._lock_event(f.event_id);
  if not (public.has_perm(f.event_id, 'package.test_mapping.edit') or public.has_perm(f.event_id, 'station.mapping.edit')) then
    raise exception 'permission_denied: package.test_mapping.edit' using errcode = '42501';
  end if;
  if f.id = t.id then raise exception 'invalid_code: choose a different visit to merge into'; end if;
  if f.location <> t.location then raise exception 'invalid_code: % is % but % is % — they cannot be merged', f.name, f.location, t.name, t.location; end if;
  perform set_config('app.reason', coalesce(nullif(btrim(p_reason), ''), 'Merged visit ' || f.name || ' into ' || t.name), true);
  update workflow_service_tests set service_id = t.id where service_id = f.id;
  get diagnostics n_tests = row_count;
  insert into station_capabilities (event_id, station_id, service_id)
  select f.event_id, station_id, t.id from station_capabilities where service_id = f.id
  on conflict do nothing;
  get diagnostics n_stations = row_count;
  update choice_groups set service_id = t.id where service_id = f.id;
  update workflow_services set active = false where id = f.id;
  perform public.write_audit(f.event_id, 'visit.merge', 'workflow_service', f.id::text, p_reason,
    jsonb_build_object('from', f.name, 'into', t.name, 'tests', n_tests, 'stations_added', n_stations));
  return jsonb_build_object('tests', n_tests, 'stations_added', n_stations);
end $$;

create or replace function public.station_link_tests(p_station uuid, p_test_ids uuid[], p_one_stop boolean default false)
returns uuid[] language plpgsql security definer set search_path = public as $$
declare s stations; v_loc text; v_own uuid; v_out uuid[] := '{}'; tt test_catalog; v_svc uuid; v_bad text;
begin
  select * into s from stations where id = p_station;
  if s.id is null then raise exception 'not_found: station'; end if;
  perform public.require_perm(s.event_id, 'station.mapping.edit');
  if s.kind not in ('station', 'walkin_centre') then raise exception 'invalid_station: only diagnostic stations and walk-in centres do tests'; end if;
  if coalesce(array_length(p_test_ids, 1), 0) = 0 then return v_out; end if;
  v_loc := case s.kind when 'walkin_centre' then 'walk_in' else 'event_day' end;
  select string_agg(display_name, ', ') into v_bad from test_catalog
   where event_id = s.event_id and id = any (p_test_ids) and location <> v_loc;
  if v_bad is not null then
    raise exception 'invalid_code: % % done at % — not at this %', v_bad, case when position(',' in v_bad) > 0 then 'are' else 'is' end,
      case v_loc when 'walk_in' then 'the event venue' else 'the walk-in centre' end,
      case s.kind when 'walkin_centre' then 'centre' else 'station' end;
  end if;
  if (select count(*) from test_catalog where event_id = s.event_id and id = any (p_test_ids)) <> (select count(distinct x) from unnest(p_test_ids) x) then
    raise exception 'invalid_test';
  end if;
  for tt in select * from test_catalog where event_id = s.event_id and id = any (p_test_ids) loop
    select service_id into v_svc from workflow_service_tests where test_id = tt.id;
    if p_one_stop or v_svc is null then
      if v_own is null then   -- the station's own visit, keyed by station code (no synonym mapping)
        select id into v_own from workflow_services where event_id = s.event_id and code = 'ROOM-' || s.code;
        if v_own is null then
          insert into workflow_services (event_id, code, name, location) values (s.event_id, 'ROOM-' || s.code, s.name, v_loc) returning id into v_own;
        else
          update workflow_services set active = true, name = s.name where id = v_own;
        end if;
      end if;
      if v_svc is distinct from v_own then
        delete from workflow_service_tests where test_id = tt.id;
        insert into workflow_service_tests (event_id, service_id, test_id) values (s.event_id, v_own, tt.id);
      end if;
      v_svc := v_own;
    end if;
    if not (v_svc = any (v_out)) then v_out := array_append(v_out, v_svc); end if;
  end loop;
  perform public.write_audit(s.event_id, 'station.tests', 'station', s.id::text, null,
    jsonb_build_object('tests', coalesce(array_length(p_test_ids, 1), 0), 'one_stop', p_one_stop));
  return v_out;
end $$;

revoke execute on function public.merge_service(uuid, uuid, text), public.station_link_tests(uuid, uuid[], boolean) from public, anon;
grant execute on function public.merge_service(uuid, uuid, text), public.station_link_tests(uuid, uuid[], boolean) to authenticated;
