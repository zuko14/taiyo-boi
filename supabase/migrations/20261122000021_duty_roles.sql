-- Assigning a shift gives the person the access that station needs. If they lack the key
-- permission for the job there, the matching role is granted (or reactivated) and audited:
--   sample collection station → phlebotomist; X-Ray / ultrasound / echo / mammography → radiology
--   technician; other diagnostic stations → station technician; registration counter → registration
--   desk; add-on / payment desk → add-on desk; walk-in centre → walk-in staff. In patient-pays camps
--   the registration counter and the payment desk also get the cashier role (payment at the desk).
-- Bank of India / sponsored camps keep payment verification separate. An explicit individual revoke
-- (Permissions → Individual grants) still wins, because has_perm() checks revokes first.

create or replace function public._user_has_perm(p_event uuid, p_user uuid, p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff_profiles where user_id = p_user and is_platform_admin) or (
    not exists (select 1 from member_permission_overrides o where o.event_id = p_event and o.user_id = p_user
                 and o.permission_code = p_perm and not o.granted)
    and (exists (select 1 from event_memberships m join role_permissions rp on rp.event_id = m.event_id and rp.role_code = m.role_code
                  where m.event_id = p_event and m.user_id = p_user and m.active and rp.permission_code = p_perm)
         or exists (select 1 from member_permission_overrides o where o.event_id = p_event and o.user_id = p_user
                     and o.permission_code = p_perm and o.granted)))
$$;

create or replace function public._grant_duty_roles(p_station uuid, p_user uuid) returns text[]
language plpgsql security definer set search_path = public as $$
declare s stations; e events; v_need text[][]; v_pair text[]; v_granted text[] := '{}'; v_pays boolean;
begin
  select * into s from stations where id = p_station;
  select * into e from events where id = s.event_id;
  v_pays := coalesce(e.settings->>'package_mode', 'custom') = 'custom' and coalesce(e.settings->>'payment_model', 'patient_pays') = 'patient_pays';
  -- {role, the permission that role is needed for}
  v_need := case s.kind
    when 'station' then array[array[
      case when exists (select 1 from station_capabilities c join workflow_services w on w.id = c.service_id where c.station_id = s.id and w.code = 'SAMPLE') then 'phlebotomist'
           when exists (select 1 from station_capabilities c join workflow_services w on w.id = c.service_id
                         where c.station_id = s.id and (w.code || ' ' || upper(w.name)) ~ '(X-?RAY|USG|ULTRA|ECHO|MAMMO|RADIO|SONO)') then 'radiology_technician'
           else 'station_staff' end, 'task.perform']]
    when 'registration_counter' then case when v_pays then array[array['registration_staff', 'registration.create'], array['cashier', 'payment.verify']]
                                          else array[array['registration_staff', 'registration.create']] end
    when 'addon_desk' then case when v_pays then array[array['addon_staff', 'addon.create'], array['cashier', 'payment.verify']]
                                else array[array['addon_staff', 'addon.create']] end
    when 'walkin_centre' then array[array['walkin_staff', 'walkin.checkin']]
  end;
  foreach v_pair slice 1 in array v_need loop
    continue when public._user_has_perm(s.event_id, p_user, v_pair[2]);
    perform set_config('app.reason', 'Automatic: shift assigned at ' || s.name, true);
    update event_memberships set active = true where event_id = s.event_id and user_id = p_user and role_code = v_pair[1];
    if not found then
      insert into event_memberships (event_id, user_id, role_code, created_by) values (s.event_id, p_user, v_pair[1], auth.uid());
    end if;
    perform public.write_audit(s.event_id, 'staff.role_auto', 'staff', p_user::text, 'Shift assigned at ' || s.name,
      jsonb_build_object('role', v_pair[1], 'station', s.code));
    v_granted := array_append(v_granted, v_pair[1]);
  end loop;
  return v_granted;
end $$;

do $do$
declare d text;
begin
  d := pg_get_functiondef('public.assign_staff(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure);
  -- anyone with an account on this event (any role, even a removed one) can be given a shift
  d := replace(d, $old$if not exists (select 1 from event_memberships where event_id = s.event_id and user_id = p_user and active) then$old$,
                  $new$if not exists (select 1 from event_memberships where event_id = s.event_id and user_id = p_user) then$new$);
  d := replace(d, $old$  perform public._rebalance_waiting(s.event_id);
  return v_id;$old$, $new$  perform public._grant_duty_roles(s.id, p_user);
  perform public._rebalance_waiting(s.event_id);
  return v_id;$new$);
  if position('_grant_duty_roles' in d) = 0 or position($x$and user_id = p_user and active) then$x$ in d) > 0 then
    raise exception 'assign_staff patch did not apply';
  end if;
  execute d;
end $do$;

revoke execute on function public._user_has_perm(uuid, uuid, text), public._grant_duty_roles(uuid, uuid) from public, anon, authenticated;
