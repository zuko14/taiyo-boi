-- Free doctor consultations at the camp.
--   doctors        : set up by admins (name, specialisation, active). No queue, no station.
--   consultations  : a patient's consultation with a doctor: booked -> completed | cancelled.
--   orders.consultation_id : tests ordered for an existing patient after (because of) a consultation,
--                    so every patient's journey can be read as "before" and "after" each consultation.
-- Existing flows are unchanged: all new parameters are optional.

create table public.doctors (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  specialization text not null default '' check (length(specialization) <= 120),
  notes text not null default '' check (length(notes) <= 300),
  active boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (event_id, id)
);
create index on public.doctors (event_id, active);

create table public.consultations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  registration_id uuid not null references public.registrations(id) on delete cascade,
  doctor_id uuid not null,
  status text not null default 'booked' check (status in ('booked','completed','cancelled')),
  note text not null default '' check (length(note) <= 300),
  booked_at timestamptz not null default now(),
  booked_by uuid default auth.uid(),
  counter_station_id uuid,
  completed_at timestamptz,
  completed_by uuid,
  cancelled_reason text,
  foreign key (event_id, doctor_id) references public.doctors(event_id, id)
);
create index on public.consultations (registration_id);
create index on public.consultations (event_id, doctor_id, status);

alter table public.orders add column consultation_id uuid references public.consultations(id) on delete set null;
create index on public.orders (consultation_id) where consultation_id is not null;

alter table public.doctors enable row level security;
alter table public.consultations enable row level security;
create policy member_read on public.doctors for select to authenticated using (public.is_member(event_id));
create policy participant_view on public.consultations for select to authenticated
  using (public.has_perm(event_id, 'participant.view') or public.has_perm(event_id, 'finance.view'));
-- writes only through the audited functions below
revoke insert, update, delete on public.doctors, public.consultations from anon, authenticated;

insert into public.permissions (code, description) values
  ('doctor.manage', 'Set up the doctors offering free consultations at the camp')
on conflict (code) do nothing;
insert into public.default_role_permissions (role_code, permission_code)
select r, 'doctor.manage' from unnest(array['event_admin','registration_supervisor']) r on conflict do nothing;
insert into public.role_permissions (event_id, role_code, permission_code)
select e.id, r, 'doctor.manage' from public.events e, unnest(array['event_admin','registration_supervisor']) r on conflict do nothing;

-- ---------------------------------------------------------------- doctors
create or replace function public.save_doctor(p_event uuid, p_id uuid, p_name text, p_specialization text,
                                              p_active boolean default true, p_notes text default '')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public.require_perm(p_event, 'doctor.manage');
  if coalesce(btrim(p_name), '') = '' then raise exception 'invalid_name: enter the doctor''s name'; end if;
  if p_id is null then
    insert into doctors (event_id, name, specialization, notes, active)
    values (p_event, btrim(p_name), btrim(coalesce(p_specialization, '')), btrim(coalesce(p_notes, '')), coalesce(p_active, true))
    returning id into v_id;
  else
    update doctors set name = btrim(p_name), specialization = btrim(coalesce(p_specialization, '')),
           notes = btrim(coalesce(p_notes, '')), active = coalesce(p_active, true)
     where id = p_id and event_id = p_event returning id into v_id;
    if v_id is null then raise exception 'not_found: doctor'; end if;
  end if;
  perform public.write_audit(p_event, case when p_id is null then 'doctor.create' else 'doctor.update' end, 'doctor', v_id::text, null,
    jsonb_build_object('name', btrim(p_name), 'specialization', p_specialization, 'active', p_active));
  return v_id;
end $$;

-- ---------------------------------------------------------------- consultations
-- internal: caller has checked duty/permission; returns the open booking with this doctor if one exists
create or replace function public._book_consultation(p_reg uuid, p_doctor uuid, p_station uuid, p_note text)
returns uuid language plpgsql security definer set search_path = public as $$
declare r registrations; d doctors; v_id uuid;
begin
  select * into r from registrations where id = p_reg;
  select * into d from doctors where id = p_doctor;
  if d.id is null or d.event_id <> r.event_id then raise exception 'not_found: doctor'; end if;
  if not d.active then raise exception 'invalid_doctor: % is not consulting now', d.name; end if;
  select id into v_id from consultations where registration_id = r.id and doctor_id = d.id and status = 'booked';
  if v_id is not null then return v_id; end if;
  insert into consultations (event_id, registration_id, doctor_id, note, counter_station_id)
  values (r.event_id, r.id, d.id, btrim(coalesce(p_note, '')), p_station) returning id into v_id;
  perform public.write_audit(r.event_id, 'consultation.book', 'consultation', v_id::text, null,
    jsonb_build_object('registration', r.registration_code, 'doctor', d.name));
  return v_id;
end $$;

create or replace function public.book_consultation(p_reg uuid, p_doctor uuid, p_counter uuid, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare r registrations; s stations;
begin
  perform public._lock_event((select event_id from registrations where id = p_reg));
  select * into r from registrations where id = p_reg;
  if not found or r.status <> 'active' then raise exception 'registration_inactive'; end if;
  s := public.assert_on_duty(p_counter, array['registration_counter']);
  if s.event_id <> r.event_id then raise exception 'invalid_station'; end if;
  perform public.require_perm(r.event_id, 'registration.create');
  perform public.assert_event_live(r.event_id);
  return public._book_consultation(r.id, p_doctor, s.id, p_note);
end $$;

create or replace function public.set_consultation_status(p_consultation uuid, p_status text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare c consultations;
begin
  perform public._lock_event((select event_id from consultations where id = p_consultation));
  select * into c from consultations where id = p_consultation for update;
  if not found then raise exception 'not_found: consultation'; end if;
  if not (public.has_perm(c.event_id, 'registration.create') or public.has_perm(c.event_id, 'task.perform')) then
    raise exception 'permission_denied: registration.create' using errcode = '42501';
  end if;
  perform public.assert_event_live(c.event_id);
  if c.status = p_status then return; end if;
  if c.status <> 'booked' or p_status not in ('completed','cancelled') then
    raise exception 'illegal_transition: consultation is %', c.status;
  end if;
  if p_status = 'cancelled' and coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  update consultations set status = p_status,
         completed_at = case when p_status = 'completed' then now() end,
         completed_by = case when p_status = 'completed' then auth.uid() end,
         cancelled_reason = case when p_status = 'cancelled' then btrim(p_reason) end
   where id = c.id;
  perform public.write_audit(c.event_id, 'consultation.' || p_status, 'consultation', c.id::text, p_reason, '{}');
end $$;

-- per doctor: consultations, and what the patients took after them (tests ordered with that consultation)
create or replace function public.doctor_insights(p_event uuid)
returns table (doctor_id uuid, name text, specialization text, active boolean, booked int, completed int, cancelled int,
               patients int, patients_with_tests int, tests_after int, amount_after_paise bigint, paid_after_paise bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.has_perm(p_event, 'doctor.manage') or public.has_perm(p_event, 'registration.create')
          or public.has_perm(p_event, 'finance.view') or public.has_perm(p_event, 'dashboard.view')) then
    raise exception 'permission_denied: doctor.manage' using errcode = '42501';
  end if;
  return query
  select d.id, d.name, d.specialization, d.active,
         (select count(*) from consultations c where c.doctor_id = d.id and c.status = 'booked')::int,
         (select count(*) from consultations c where c.doctor_id = d.id and c.status = 'completed')::int,
         (select count(*) from consultations c where c.doctor_id = d.id and c.status = 'cancelled')::int,
         (select count(distinct c.registration_id) from consultations c where c.doctor_id = d.id and c.status <> 'cancelled')::int,
         (select count(distinct o.registration_id) from orders o join consultations c on c.id = o.consultation_id
           where c.doctor_id = d.id and o.status = 'active')::int,
         (select count(*) from order_items oi join orders o on o.id = oi.order_id join consultations c on c.id = o.consultation_id
           where c.doctor_id = d.id and o.status = 'active' and oi.status = 'active')::int,
         (select coalesce(sum(o.total_paise), 0) from orders o join consultations c on c.id = o.consultation_id
           where c.doctor_id = d.id and o.status = 'active')::bigint,
         (select coalesce(sum(i.amount_paise - i.refunded_paise), 0) from payment_intents i join orders o on o.id = i.order_id
            join consultations c on c.id = o.consultation_id
           where c.doctor_id = d.id and i.status in ('paid','partially_refunded'))::bigint
    from doctors d
   where d.event_id = p_event
   order by d.name;
end $$;

do $do$
declare d text;
begin
  -- ------------------------------------------------ create_addon_order: optional link to a consultation
  d := pg_get_functiondef('public.create_addon_order(uuid,uuid,uuid[],text,boolean,jsonb,text)'::regprocedure);
  d := replace(d, $old$p_discount_reason text DEFAULT NULL::text)
 RETURNS$old$, $new$p_discount_reason text DEFAULT NULL::text, p_consultation uuid DEFAULT NULL::uuid)
 RETURNS$new$);
  d := replace(d, $old$  if not found or r.status <> 'active' then raise exception 'registration_inactive'; end if;$old$,
    $new$  if not found or r.status <> 'active' then raise exception 'registration_inactive'; end if;
  if p_consultation is not null and not exists (select 1 from consultations where id = p_consultation
                                                  and registration_id = r.id and status <> 'cancelled') then
    raise exception 'invalid_consultation: that consultation is not this patient''s';
  end if;$new$);
  d := replace(d, $old$list_total_paise, discount_reason, discounted_by)$old$, $new$list_total_paise, discount_reason, discounted_by, consultation_id)$new$);
  d := replace(d, $old$then auth.uid() end) returning id into v_order;$old$, $new$then auth.uid() end, p_consultation) returning id into v_order;$new$);
  if position('p_consultation uuid' in d) = 0 or position('invalid_consultation' in d) = 0
     or position('discounted_by, consultation_id)' in d) = 0 or position('end, p_consultation) returning id into v_order' in d) = 0 then
    raise exception 'create_addon_order patch did not apply';
  end if;
  drop function public.create_addon_order(uuid, uuid, uuid[], text, boolean, jsonb, text);
  execute d;

  -- ------------------------------------------------ register_participant: optional consultation (or consultation only)
  d := pg_get_functiondef('public.register_participant(uuid,text,text,text,integer,text,text,text,text,boolean,uuid,text,uuid[],jsonb,numeric,text)'::regprocedure);
  d := replace(d, $old$p_discount_reason text DEFAULT NULL::text)
 RETURNS$old$, $new$p_discount_reason text DEFAULT NULL::text, p_doctor uuid DEFAULT NULL::uuid)
 RETURNS$new$);
  d := replace(d, $old$v_pkg_pct numeric(5,2) := coalesce(p_package_discount_pct, 0);$old$, $new$v_pkg_pct numeric(5,2) := coalesce(p_package_discount_pct, 0); v_consult uuid;$new$);
  d := replace(d, $old$    if not v_has_tests or public.package_mode(e.id) <> 'custom' then$old$,
    $new$    if (not v_has_tests and p_doctor is null) or public.package_mode(e.id) <> 'custom' then$new$);
  d := replace(d, $old$  if jsonb_array_length(v_snapshot->'tests') = 0 and not v_has_tests then$old$,
    $new$  if jsonb_array_length(v_snapshot->'tests') = 0 and not v_has_tests and p_doctor is null then$new$);
  d := replace(d, $old$  v_assign := public._schedule_next(r.id);
  return jsonb_build_object('registration_id', r.id, 'registration_code', v_code, 'already', false,$old$,
    $new$  if p_doctor is not null then v_consult := public._book_consultation(r.id, p_doctor, s.id, null); end if;
  v_assign := public._schedule_next(r.id);
  return jsonb_build_object('registration_id', r.id, 'registration_code', v_code, 'already', false, 'consultation_id', v_consult,$new$);
  if position('p_doctor uuid' in d) = 0 or position('v_consult uuid' in d) = 0 or position('(not v_has_tests and p_doctor is null)' in d) = 0
     or position('and not v_has_tests and p_doctor is null then' in d) = 0 or position('_book_consultation(r.id, p_doctor' in d) = 0 then
    raise exception 'register_participant patch did not apply';
  end if;
  drop function public.register_participant(uuid, text, text, text, integer, text, text, text, text, boolean, uuid, text, uuid[], jsonb, numeric, text);
  execute d;

  -- ------------------------------------------------ portal: the patient's consultations
  d := pg_get_functiondef('public.portal_view(text)'::regprocedure);
  d := replace(d, $old$    'report_centres', coalesce($old$, $new$    'consultations', coalesce((select jsonb_agg(jsonb_build_object('doctor', dr.name, 'specialization', dr.specialization,
                 'status', c.status, 'booked_at', c.booked_at) order by c.booked_at)
             from consultations c join doctors dr on dr.id = c.doctor_id
            where c.registration_id = r.id and c.status <> 'cancelled'), '[]'::jsonb),
    'report_centres', coalesce($new$);
  if position('''consultations'', coalesce(' in d) = 0 then raise exception 'portal_view patch did not apply'; end if;
  execute d;
end $do$;

revoke execute on function public._book_consultation(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.save_doctor(uuid, uuid, text, text, boolean, text), public.book_consultation(uuid, uuid, uuid, text),
  public.set_consultation_status(uuid, text, text), public.doctor_insights(uuid),
  public.create_addon_order(uuid, uuid, uuid[], text, boolean, jsonb, text, uuid),
  public.register_participant(uuid, text, text, text, integer, text, text, text, text, boolean, uuid, text, uuid[], jsonb, numeric, text, uuid)
  from public, anon;
grant execute on function public.save_doctor(uuid, uuid, text, text, boolean, text), public.book_consultation(uuid, uuid, uuid, text),
  public.set_consultation_status(uuid, text, text), public.doctor_insights(uuid),
  public.create_addon_order(uuid, uuid, uuid[], text, boolean, jsonb, text, uuid),
  public.register_participant(uuid, text, text, text, integer, text, text, text, text, boolean, uuid, text, uuid[], jsonb, numeric, text, uuid)
  to authenticated;
