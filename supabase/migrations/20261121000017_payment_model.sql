-- Who pays at a camp (events.settings.payment_model), enforced by the server, not only the UI:
--   'patient_pays' (default for custom camps): tests/packages are paid at registration.
--   'sponsored': the organiser pays; nothing is charged at registration (package prices ignored,
--     no tests sold at the counter). Bank of India (female_male) events are always sponsored.
-- Revenue insights also list the latest verified payments (patient, what was paid for, method).

do $do$
declare d text;
begin
  d := pg_get_functiondef('public.register_participant(uuid,text,text,text,integer,text,text,text,text,boolean,uuid,text,uuid[])'::regprocedure);
  d := replace(d, $old$  if v_has_tests and public.package_mode(e.id) <> 'custom' then$old$,
    $new$  if v_has_tests and coalesce(e.settings->>'payment_model', 'patient_pays') = 'sponsored' then
    raise exception 'package_mode: this camp is sponsored — participants are not charged at registration';
  end if;
  if v_has_tests and public.package_mode(e.id) <> 'custom' then$new$);
  d := replace(d, $old$  if coalesce(pkg.price_paise, 0) > 0 then$old$,
    $new$  if coalesce(pkg.price_paise, 0) > 0 and coalesce(e.settings->>'payment_model', 'patient_pays') <> 'sponsored' then$new$);
  if position('this camp is sponsored' in d) = 0 or position($x$<> 'sponsored' then$x$ in d) = 0 then
    raise exception 'register_participant patch did not apply';
  end if;
  execute d;

  d := pg_get_functiondef('public.revenue_insights(uuid)'::regprocedure);
  d := replace(d, $old$    'registrations', (select count(*) from registrations where event_id = p_event and status = 'active'));$old$,
    $new$    'recent', coalesce((select jsonb_agg(x order by x->>'at' desc) from (
        select jsonb_build_object('at', pt.created_at, 'amount_paise', pt.amount_paise, 'method', pt.method,
                 'code', r.registration_code, 'name', p.full_name, 'kind', o.kind,
                 'what', case when o.kind = 'package' then pk.name
                              else (select string_agg(oi.test_name, ', ' order by oi.test_name) from order_items oi where oi.order_id = o.id) end,
                 'receipt', (select receipt_no from receipts where intent_id = i.id), 'intent_id', i.id) x
          from payment_transactions pt join payment_intents i on i.id = pt.intent_id join orders o on o.id = i.order_id
          join registrations r on r.id = i.registration_id join participants p on p.id = r.participant_id
          join packages pk on pk.id = r.package_id
         where pt.event_id = p_event and pt.status = 'verified'
         order by pt.created_at desc limit 50) q), '[]'),
    'registrations', (select count(*) from registrations where event_id = p_event and status = 'active'));$new$);
  if position('''recent''' in d) = 0 then raise exception 'revenue_insights patch did not apply'; end if;
  execute d;
end $do$;

-- existing custom camps keep their behaviour (they could already charge); BOI stays sponsored
update public.events set settings = settings || jsonb_build_object('payment_model',
  case when settings->>'package_mode' = 'female_male' then 'sponsored' else 'patient_pays' end)
 where not (settings ? 'payment_model');

-- a new camp is not a Bank of India camp unless created from that template
alter table public.events alter column sponsor_name set default '';
do $do$
declare d text;
begin
  d := pg_get_functiondef('public.apply_brochure_template(uuid)'::regprocedure);
  d := replace(d, $old$'{"grouping_approved": false, "package_mode": "female_male"}'::jsonb$old$,
    $new$'{"grouping_approved": false, "package_mode": "female_male", "payment_model": "sponsored"}'::jsonb, sponsor_name = 'Bank of India'$new$);
  if position($x$sponsor_name = 'Bank of India'$x$ in d) = 0 then raise exception 'apply_brochure_template patch did not apply'; end if;
  execute d;
end $do$;

-- registration codes of a new camp start with its own event code (e.g. VV-2026 → VV-T-2026-000001);
-- the Bank of India template keeps BOI. Existing events are unchanged.
do $do$
declare d text;
begin
  d := pg_get_functiondef('public.create_event(text,text,text)'::regprocedure);
  d := replace(d, $old$insert into events (code, name, timezone) values (upper(btrim(p_code)), btrim(p_name), p_timezone)$old$,
    $new$insert into events (code, name, timezone, code_prefix)
  values (upper(btrim(p_code)), btrim(p_name), p_timezone,
          coalesce(nullif(left(regexp_replace(upper(split_part(btrim(p_code), '-', 1)), '[^A-Z0-9]', '', 'g'), 8), ''), 'EV'))$new$);
  if position('code_prefix' in d) = 0 then raise exception 'create_event patch did not apply'; end if;
  execute d;

  d := pg_get_functiondef('public.apply_brochure_template(uuid)'::regprocedure);
  d := replace(d, $old$, sponsor_name = 'Bank of India'$old$, $new$, sponsor_name = 'Bank of India', code_prefix = 'BOI'$new$);
  if position($x$code_prefix = 'BOI'$x$ in d) = 0 then raise exception 'apply_brochure_template prefix patch did not apply'; end if;
  execute d;
end $do$;
