-- Referrals: which doctor referred / recommended a patient's tests.
--   A camp doctor (doctors row) or an outside doctor (free-text name), recorded on the registration
--   (first visit) and on every order (test purchase). Tests ordered after a consultation are referred by
--   that consultation's doctor unless the desk names another one.
--   referral_insights() attributes every order to exactly one referrer (or "not referred"), using the same
--   money definition as Revenue insights (verified payments − refunds), so the rows add up to the total.

alter table public.registrations
  add column referred_by_doctor_id uuid,
  add column referred_by_name text check (referred_by_name is null or length(referred_by_name) between 1 and 120),
  add constraint registrations_referred_doctor_fk foreign key (event_id, referred_by_doctor_id) references public.doctors(event_id, id);
alter table public.orders
  add column referred_by_doctor_id uuid,
  add column referred_by_name text check (referred_by_name is null or length(referred_by_name) between 1 and 120),
  add constraint orders_referred_doctor_fk foreign key (event_id, referred_by_doctor_id) references public.doctors(event_id, id);
create index on public.orders (event_id, referred_by_doctor_id) where referred_by_doctor_id is not null;

-- tests already linked to a consultation are referred by that doctor
update public.orders o set referred_by_doctor_id = c.doctor_id
  from public.consultations c where c.id = o.consultation_id and o.referred_by_doctor_id is null and o.referred_by_name is null;

-- validates a referral; returns the cleaned outside name (null when a camp doctor or none)
create or replace function public._check_referral(p_event uuid, p_doctor uuid, p_name text) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if p_doctor is not null and not exists (select 1 from doctors where id = p_doctor and event_id = p_event) then
    raise exception 'invalid_doctor: referring doctor not found';
  end if;
  if p_doctor is not null and nullif(btrim(p_name), '') is not null then
    raise exception 'invalid_doctor: choose a camp doctor or type an outside doctor, not both';
  end if;
  if length(btrim(coalesce(p_name, ''))) > 120 then raise exception 'invalid_name: doctor name is too long'; end if;
  return nullif(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'), '');
end $$;

do $do$
declare d text;
begin
  -- ------------------------------------------------ create_addon_order: referral on the order
  d := pg_get_functiondef('public.create_addon_order(uuid,uuid,uuid[],text,boolean,jsonb,text,uuid)'::regprocedure);
  d := replace(d, $old$p_consultation uuid DEFAULT NULL::uuid)
 RETURNS$old$, $new$p_consultation uuid DEFAULT NULL::uuid, p_referred_doctor uuid DEFAULT NULL::uuid, p_referred_name text DEFAULT NULL::text)
 RETURNS$new$);
  d := replace(d, $old$    raise exception 'invalid_consultation: that consultation is not this patient''s';
  end if;$old$, $new$    raise exception 'invalid_consultation: that consultation is not this patient''s';
  end if;
  p_referred_name := public._check_referral(r.event_id, p_referred_doctor, p_referred_name);
  if p_referred_doctor is null and p_referred_name is null and p_consultation is not null then
    p_referred_doctor := (select doctor_id from consultations where id = p_consultation);
  end if;$new$);
  d := replace(d, $old$discounted_by, consultation_id)$old$, $new$discounted_by, consultation_id, referred_by_doctor_id, referred_by_name)$new$);
  d := replace(d, $old$end, p_consultation) returning id into v_order;$old$, $new$end, p_consultation, p_referred_doctor, p_referred_name) returning id into v_order;$new$);
  if position('p_referred_name text' in d) = 0 or position('_check_referral(r.event_id' in d) = 0
     or position('consultation_id, referred_by_doctor_id, referred_by_name)' in d) = 0
     or position('p_consultation, p_referred_doctor, p_referred_name) returning' in d) = 0 then
    raise exception 'create_addon_order patch did not apply';
  end if;
  drop function public.create_addon_order(uuid, uuid, uuid[], text, boolean, jsonb, text, uuid);
  execute d;

  -- ------------------------------------------------ register_participant: referral on the registration and its orders
  d := pg_get_functiondef('public.register_participant(uuid,text,text,text,integer,text,text,text,text,boolean,uuid,text,uuid[],jsonb,numeric,text,uuid)'::regprocedure);
  d := replace(d, $old$p_doctor uuid DEFAULT NULL::uuid)
 RETURNS$old$, $new$p_doctor uuid DEFAULT NULL::uuid, p_referred_doctor uuid DEFAULT NULL::uuid, p_referred_name text DEFAULT NULL::text)
 RETURNS$new$);
  d := replace(d, $old$  if p_doctor is not null then v_consult := public._book_consultation(r.id, p_doctor, s.id, null); end if;$old$,
    $new$  if p_doctor is not null then v_consult := public._book_consultation(r.id, p_doctor, s.id, null); end if;
  p_referred_name := public._check_referral(e.id, p_referred_doctor, p_referred_name);
  if p_referred_doctor is not null or p_referred_name is not null then
    update registrations set referred_by_doctor_id = p_referred_doctor, referred_by_name = p_referred_name where id = r.id;
    -- every order of this new registration (package and tests) carries the referral
    update orders set referred_by_doctor_id = p_referred_doctor, referred_by_name = p_referred_name where registration_id = r.id;
  end if;$new$);
  if position('p_referred_name text' in d) = 0 or position('update registrations set referred_by_doctor_id' in d) = 0 then
    raise exception 'register_participant patch did not apply';
  end if;
  drop function public.register_participant(uuid, text, text, text, integer, text, text, text, text, boolean, uuid, text, uuid[], jsonb, numeric, text, uuid);
  execute d;
end $do$;

-- One row per referrer (camp doctor, outside doctor name, or "not referred"); every active order counted once.
-- collected = verified payments − refunds for the referrer's orders (same as Revenue insights' net collected).
create or replace function public.referral_insights(p_event uuid)
returns table (kind text, doctor_id uuid, name text, specialization text, patients int, orders int, tests int,
               ordered_paise bigint, collected_paise bigint, pending_paise bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.has_perm(p_event, 'finance.view') or public.has_perm(p_event, 'dashboard.view') or public.has_perm(p_event, 'doctor.manage')) then
    raise exception 'permission_denied: finance.view' using errcode = '42501';
  end if;
  return query
  with o as (
    select x.id, x.registration_id, x.total_paise,
           coalesce(x.referred_by_doctor_id, c.doctor_id) as doc,
           case when x.referred_by_doctor_id is null and c.doctor_id is null then lower(x.referred_by_name) end as ext
      from orders x left join consultations c on c.id = x.consultation_id
     where x.event_id = p_event and x.status = 'active'),
  money as (
    select o.*,
           (select count(*) from order_items oi where oi.order_id = o.id and oi.status = 'active') as n_tests,
           coalesce((select sum(pt.amount_paise) from payment_transactions pt join payment_intents i on i.id = pt.intent_id
                      where i.order_id = o.id and pt.status = 'verified'), 0)
           - coalesce((select sum(rf.amount_paise) from refunds rf join payment_intents i on i.id = rf.intent_id where i.order_id = o.id), 0) as coll,
           coalesce((select sum(i.amount_paise) from payment_intents i where i.order_id = o.id and i.status in ('pending','requires_review')), 0) as pend
      from o)
  select case when m.doc is not null then 'camp' when m.ext is not null then 'outside' else 'none' end,
         m.doc,
         coalesce((select dr.name from doctors dr where dr.id = m.doc), min(x.referred_by_name), 'Not referred'),
         coalesce((select dr.specialization from doctors dr where dr.id = m.doc), ''),
         count(distinct m.registration_id)::int, count(*) filter (where m.total_paise > 0 or m.n_tests > 0)::int,
         sum(m.n_tests)::int, sum(m.total_paise)::bigint, sum(m.coll)::bigint, sum(m.pend)::bigint
    from money m join orders x on x.id = m.id
   group by m.doc, m.ext
   order by (m.doc is null and m.ext is null), sum(m.coll) desc, 3;
end $$;

revoke execute on function public._check_referral(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.referral_insights(uuid),
  public.create_addon_order(uuid, uuid, uuid[], text, boolean, jsonb, text, uuid, uuid, text),
  public.register_participant(uuid, text, text, text, integer, text, text, text, text, boolean, uuid, text, uuid[], jsonb, numeric, text, uuid, uuid, text)
  from public, anon;
grant execute on function public.referral_insights(uuid),
  public.create_addon_order(uuid, uuid, uuid[], text, boolean, jsonb, text, uuid, uuid, text),
  public.register_participant(uuid, text, text, text, integer, text, text, text, text, boolean, uuid, text, uuid[], jsonb, numeric, text, uuid, uuid, text)
  to authenticated;
