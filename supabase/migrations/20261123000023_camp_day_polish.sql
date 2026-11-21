-- Camp-day polish:
--   1. A test with an active price is always sellable (fixes ECG / 2D Echo missing at the desk).
--   2. Free-form registration codes: {CLS} optional (e.g. "VV001"); one shared counter when the
--      format has no {CLS}; codes never collide even after a format change.
--   3. Online report window: reports viewable in the portal for N days after the event, then the
--      participant is sent to the walk-in centre. Enforced in the database (OTP + report list).
--   4. Staff on duty per station, for the desk, the station screens and the participant portal.

-- ---------------------------------------------------------------- 1. priced => sellable
create or replace function public._price_makes_sellable() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.active then
    update test_catalog set addon_available = true where id = new.test_id and not addon_available;
  end if;
  return new;
end $$;
drop trigger if exists price_makes_sellable on public.addon_prices;
create trigger price_makes_sellable after insert or update of active on public.addon_prices
  for each row execute function public._price_makes_sellable();
update public.test_catalog t set addon_available = true
 where not t.addon_available and exists (select 1 from addon_prices a where a.test_id = t.id and a.active);

-- ---------------------------------------------------------------- 2. registration code format
alter table public.events drop constraint if exists events_code_format_tokens;
alter table public.events add constraint events_code_format_tokens
  check (code_format like '%{SEQ}%' and length(code_format) <= 60);

-- Next unique code for a registration. Called inside register_participant (event lock held).
create or replace function public._next_registration_code(e public.events, pkg public.packages) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_key text := case when e.code_format like '%{CLS}%' then pkg.classification else '_all' end;
  v_seq int; v_code text;
begin
  loop
    insert into package_code_counters (event_id, classification, next_seq) values (e.id, v_key, 2)
    on conflict (event_id, classification) do update set next_seq = package_code_counters.next_seq + 1
    returning next_seq - 1 into v_seq;
    v_code := upper(replace(replace(replace(replace(e.code_format,
                '{PREFIX}', e.code_prefix), '{CLS}', coalesce(pkg.code_letter, '')), '{YEAR}', e.code_year::text),
                '{SEQ}', lpad(v_seq::text, greatest(e.code_seq_digits, length(v_seq::text)), '0')));
    -- a code issued under an earlier format is skipped, never reused
    exit when not exists (select 1 from registrations where event_id = e.id and registration_code = v_code);
  end loop;
  return v_code;
end $$;
revoke execute on function public._next_registration_code(public.events, public.packages) from public, anon, authenticated;

do $do$
declare d text;
begin
  d := pg_get_functiondef('public.register_participant(uuid,text,text,text,integer,text,text,text,text,boolean,uuid,text,uuid[])'::regprocedure);
  d := replace(d, $old$  insert into package_code_counters (event_id, classification, next_seq) values (e.id, pkg.classification, 2)
  on conflict (event_id, classification) do update set next_seq = package_code_counters.next_seq + 1
  returning next_seq - 1 into v_seq;
  v_code := replace(replace(replace(replace(e.code_format,
              '{PREFIX}', e.code_prefix), '{CLS}', pkg.code_letter), '{YEAR}', e.code_year::text),
              '{SEQ}', lpad(v_seq::text, e.code_seq_digits, '0'));$old$,
    $new$  v_code := public._next_registration_code(e, pkg);$new$);
  if position('_next_registration_code' in d) = 0 then raise exception 'register_participant patch did not apply'; end if;
  execute d;
end $do$;

-- ---------------------------------------------------------------- 3. online report window
-- settings.report_access_days: blank = no limit. Counted in whole days after the event's last day
-- (event timezone): 3 means reports stay online until 23:59 on the third day after the camp.
create or replace function public.reports_online_until(p_event uuid) returns timestamptz
language sql stable security definer set search_path = public as $$
  select case when nullif(e.settings->>'report_access_days', '') is null or coalesce(e.ends_at, e.starts_at) is null then null
         else (((coalesce(e.ends_at, e.starts_at) at time zone e.timezone)::date
                + (e.settings->>'report_access_days')::int + 1)::timestamp at time zone e.timezone) end
    from events e where e.id = p_event
$$;

-- staff view of the same date (Event & readiness)
create or replace function public.reports_window(p_event uuid) returns timestamptz
language sql stable security definer set search_path = public as $$
  select case when public.is_member(p_event) then public.reports_online_until(p_event) end
$$;
revoke execute on function public.reports_window(uuid) from public, anon;
grant execute on function public.reports_window(uuid) to authenticated;

create or replace function public._portal_reports_closed(p_reg uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(now() >= public.reports_online_until(r.event_id), false) from registrations r where r.id = p_reg
$$;

create or replace function public.portal_otp_request(p_token_hash text, p_code_hash text) returns text
language plpgsql security definer set search_path = public as $$
declare v_reg uuid := public.portal_registration(p_token_hash); v_mobile text;
begin
  if v_reg is null then raise exception 'invalid_token'; end if;
  if public._portal_reports_closed(v_reg) then raise exception 'reports_closed'; end if;
  select p.mobile into v_mobile from registrations r join participants p on p.id = r.participant_id where r.id = v_reg;
  if v_mobile is null then raise exception 'no_mobile: please contact the help desk'; end if;
  if (select count(*) from portal_otps where registration_id = v_reg and created_at > now() - interval '15 minutes') >= 3 then
    raise exception 'rate_limited: too many codes requested, try again later';
  end if;
  insert into portal_otps (registration_id, code_hash, expires_at) values (v_reg, p_code_hash, now() + interval '5 minutes');
  return v_mobile;
end $$;

create or replace function public.portal_reports(p_token_hash text, p_session_hash text)
returns table (report_id uuid, title text, test_name text, version int, published_at timestamptz, storage_key text, mime_type text)
language plpgsql stable security definer set search_path = public as $$
declare v_reg uuid := public.portal_registration(p_token_hash);
begin
  if v_reg is null or not exists (select 1 from portal_sessions where registration_id = v_reg
                                   and session_hash = p_session_hash and expires_at > now()) then
    raise exception 'verification_required';
  end if;
  if public._portal_reports_closed(v_reg) then raise exception 'reports_closed'; end if;
  return query select rp.id, rp.title, oi.test_name, rp.version, rp.published_at, rp.storage_key, rp.mime_type
    from reports rp join order_items oi on oi.id = rp.order_item_id
   where rp.registration_id = v_reg and rp.status = 'published' order by oi.test_name;
end $$;

-- ---------------------------------------------------------------- 4. staff on duty
-- Names of staff on shift now at each station of the event (for desk / station / queue screens).
create or replace function public.station_on_duty(p_event uuid)
returns table (station_id uuid, staff text)
language sql stable security definer set search_path = public as $$
  select a.station_id, string_agg(distinct sp.full_name, ', ')
    from staff_assignments a join staff_profiles sp on sp.user_id = a.user_id
   where a.event_id = p_event and public.is_member(p_event) and a.status = 'active'
     and now() between a.shift_start and a.shift_end
   group by a.station_id
$$;
revoke execute on function public.station_on_duty(uuid) from public, anon;
grant execute on function public.station_on_duty(uuid) to authenticated;

-- portal: staff name at the next station, report window and the centres to collect reports from
do $do$
declare d text;
begin
  d := pg_get_functiondef('public.portal_view(text)'::regprocedure);
  d := replace(d, $old$'station_code', s.code, 'location', s.location,$old$,
    $new$'station_code', s.code, 'location', s.location,
                         'staff', (select string_agg(distinct sp.full_name, ', ') from staff_assignments a
                                     join staff_profiles sp on sp.user_id = a.user_id
                                    where a.station_id = s.id and a.status = 'active'
                                      and now() between a.shift_start and a.shift_end),$new$);
  d := replace(d, $old$'upi_vpa', e.settings->>'upi_vpa', 'upi_payee_name', e.settings->>'upi_payee_name'),$old$,
    $new$'upi_vpa', e.settings->>'upi_vpa', 'upi_payee_name', e.settings->>'upi_payee_name',
                                'reports_until', public.reports_online_until(e.id),
                                'reports_closed', coalesce(now() >= public.reports_online_until(e.id), false),
                                'reports_note', e.settings->>'report_closed_note'),$new$);
  d := replace(d, $old$    'choice_groups', (select$old$,
    $new$    'report_centres', coalesce((select jsonb_agg(jsonb_build_object('name', s.name, 'address', s.address,
                 'hours', s.operating_hours, 'instructions', s.instructions) order by s.name)
             from stations s where s.event_id = r.event_id and s.kind = 'walkin_centre' and s.status <> 'closed'), '[]'::jsonb),
    'choice_groups', (select$new$);
  if position('''staff'', (select' in d) = 0 or position('''reports_until''' in d) = 0 or position('''report_centres''' in d) = 0 then
    raise exception 'portal_view patch did not apply';
  end if;
  execute d;
end $do$;

revoke execute on function public._price_makes_sellable(), public.reports_online_until(uuid), public._portal_reports_closed(uuid),
  public.portal_otp_request(text, text), public.portal_reports(text, text) from public, anon, authenticated;
