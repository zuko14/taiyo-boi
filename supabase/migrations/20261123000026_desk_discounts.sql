-- Per-patient discount given at the registration desk (not a catalogue price change).
-- Staff with registration.discount enter a % for a selected test and/or the package, with a reason.
-- Tracked on the patient's own order lines (original price, %, who, why) and in the audit log.

alter table public.order_items
  add column list_price_paise bigint check (list_price_paise >= 0),
  add column discount_pct numeric(5,2) not null default 0 check (discount_pct >= 0 and discount_pct <= 100);
alter table public.orders
  add column list_total_paise bigint check (list_total_paise >= 0),
  add column discount_pct numeric(5,2) not null default 0 check (discount_pct >= 0 and discount_pct <= 100),
  add column discount_reason text,
  add column discounted_by uuid;

insert into public.permissions (code, description) values
  ('registration.discount', 'Give a patient a discount at the registration desk (reason required, audited)')
on conflict (code) do nothing;
insert into public.default_role_permissions (role_code, permission_code)
select r, 'registration.discount' from unnest(array['registration_staff','registration_supervisor','event_admin']) r
on conflict do nothing;
insert into public.role_permissions (event_id, role_code, permission_code)
select e.id, r, 'registration.discount' from public.events e, unnest(array['registration_staff','registration_supervisor','event_admin']) r
on conflict do nothing;

do $do$
declare d text;
begin
  -- ------------------------------------------------ create_addon_order: optional per-test discounts
  d := pg_get_functiondef('public.create_addon_order(uuid,uuid,uuid[],text,boolean)'::regprocedure);
  d := replace(d, $old$p_consent boolean)
 RETURNS$old$, $new$p_consent boolean, p_discounts jsonb DEFAULT NULL::jsonb, p_discount_reason text DEFAULT NULL::text)
 RETURNS$new$);
  d := replace(d, $old$rule text) on commit drop;$old$, $new$rule text, list_price bigint, pct numeric(5,2) not null default 0) on commit drop;$new$);
  d := replace(d, $old$  select sum(price + tax) into v_total from _addon_lines;$old$, $new$  -- per-patient desk discount: {test_id: percent}; taken off this patient's price only
  if p_discounts is not null and p_discounts <> '{}'::jsonb then
    perform public.require_perm(r.event_id, 'registration.discount');
    if coalesce(btrim(p_discount_reason), '') = '' then raise exception 'reason_required: say why this patient gets a discount'; end if;
    if jsonb_typeof(p_discounts) <> 'object' or exists (
         select 1 from jsonb_each_text(p_discounts) x
          where x.value !~ '^[0-9]{1,3}([.][0-9]{1,2})?$' or x.value::numeric > 100
             or not exists (select 1 from _addon_lines l where l.test_id::text = x.key)) then
      raise exception 'invalid_amount: a discount must be 0–100%% on one of the selected tests';
    end if;
    update _addon_lines l set list_price = l.price, pct = (p_discounts->>l.test_id::text)::numeric,
           price = round(l.price * (100 - (p_discounts->>l.test_id::text)::numeric) / 100)
     where p_discounts ? l.test_id::text and (p_discounts->>l.test_id::text)::numeric > 0;
  end if;
  select sum(price + tax) into v_total from _addon_lines;$new$);
  d := replace(d, $old$  insert into orders (event_id, registration_id, kind, total_paise, idempotency_key, consent_at, desk_station_id, created_by)
  values (r.event_id, r.id, 'addon', v_total, p_idempotency_key, now(), s.id, auth.uid()) returning id into v_order;$old$,
    $new$  insert into orders (event_id, registration_id, kind, total_paise, idempotency_key, consent_at, desk_station_id, created_by,
                      list_total_paise, discount_reason, discounted_by)
  values (r.event_id, r.id, 'addon', v_total, p_idempotency_key, now(), s.id, auth.uid(),
          case when exists (select 1 from _addon_lines where pct > 0) then (select sum(coalesce(list_price, price) + tax) from _addon_lines) end,
          case when exists (select 1 from _addon_lines where pct > 0) then btrim(p_discount_reason) end,
          case when exists (select 1 from _addon_lines where pct > 0) then auth.uid() end) returning id into v_order;$new$);
  d := replace(d, $old$unit_price_paise, tax_paise, completion_rule)
      select r.event_id, v_order, r.id, test_id, code, name, location, 'addon', 'employee', price, tax, rule$old$,
    $new$unit_price_paise, tax_paise, completion_rule, list_price_paise, discount_pct)
      select r.event_id, v_order, r.id, test_id, code, name, location, 'addon', 'employee', price, tax, rule, list_price, pct$new$);
  d := replace(d, $old$jsonb_build_object('total_paise', v_total, 'tests', (select jsonb_agg(code) from _addon_lines))$old$,
    $new$jsonb_build_object('total_paise', v_total, 'tests', (select jsonb_agg(code) from _addon_lines),
                       'discounts', (select jsonb_agg(jsonb_build_object('test', code, 'pct', pct, 'list_paise', list_price, 'price_paise', price))
                                       from _addon_lines where pct > 0),
                       'discount_reason', case when exists (select 1 from _addon_lines where pct > 0) then p_discount_reason end)$new$);
  if position('p_discounts jsonb' in d) = 0 or position('list_price, pct' in d) = 0 or position('pct numeric(5,2) not null default 0) on commit drop' in d) = 0
     or position('registration.discount' in d) = 0 or position('discounted_by)' in d) = 0 or position('''discounts'', (select' in d) = 0 then
    raise exception 'create_addon_order patch did not apply';
  end if;
  drop function public.create_addon_order(uuid, uuid, uuid[], text, boolean);
  execute d;

  -- ------------------------------------------------ register_participant: test + package discounts
  d := pg_get_functiondef('public.register_participant(uuid,text,text,text,integer,text,text,text,text,boolean,uuid,text,uuid[])'::regprocedure);
  d := replace(d, $old$p_test_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS$old$, $new$p_test_ids uuid[] DEFAULT NULL::uuid[], p_discounts jsonb DEFAULT NULL::jsonb, p_package_discount_pct numeric DEFAULT NULL::numeric, p_discount_reason text DEFAULT NULL::text)
 RETURNS$new$);
  d := replace(d, $old$  v_order uuid; v_intent uuid; v_tests jsonb;$old$, $new$  v_order uuid; v_intent uuid; v_tests jsonb; v_pkg_price bigint; v_pkg_pct numeric(5,2) := coalesce(p_package_discount_pct, 0);$new$);
  d := replace(d, $old$  if coalesce(pkg.price_paise, 0) > 0 and coalesce(e.settings->>'payment_model', 'patient_pays') <> 'sponsored' then
    insert into orders (event_id, registration_id, kind, total_paise, created_by)
    values (e.id, r.id, 'package', pkg.price_paise, auth.uid()) returning id into v_order;
    insert into payment_intents (event_id, order_id, registration_id, amount_paise, created_by)
    values (e.id, v_order, r.id, pkg.price_paise, auth.uid()) returning id into v_intent;
  end if;$old$, $new$  v_pkg_price := case when coalesce(e.settings->>'payment_model', 'patient_pays') <> 'sponsored' then coalesce(pkg.price_paise, 0) else 0 end;
  if v_pkg_pct <> 0 then                  -- per-patient package discount at the desk
    if v_pkg_pct < 0 or v_pkg_pct > 100 then raise exception 'invalid_amount: a discount must be 0–100%%'; end if;
    if v_pkg_price = 0 then raise exception 'invalid_amount: this package has no price to discount'; end if;
    perform public.require_perm(e.id, 'registration.discount');
    if coalesce(btrim(p_discount_reason), '') = '' then raise exception 'reason_required: say why this patient gets a discount'; end if;
  end if;
  if v_pkg_price > 0 then
    insert into orders (event_id, registration_id, kind, total_paise, created_by, list_total_paise, discount_pct, discount_reason, discounted_by)
    values (e.id, r.id, 'package', round(v_pkg_price * (100 - v_pkg_pct) / 100), auth.uid(),
            case when v_pkg_pct > 0 then v_pkg_price end, v_pkg_pct,
            case when v_pkg_pct > 0 then btrim(p_discount_reason) end, case when v_pkg_pct > 0 then auth.uid() end)
    returning id into v_order;
    if round(v_pkg_price * (100 - v_pkg_pct) / 100) > 0 then
      insert into payment_intents (event_id, order_id, registration_id, amount_paise, created_by)
      values (e.id, v_order, r.id, round(v_pkg_price * (100 - v_pkg_pct) / 100), auth.uid()) returning id into v_intent;
    end if;
  end if;$new$);
  d := replace(d, $old$p_idempotency_key || ':tests', p_consent);$old$, $new$p_idempotency_key || ':tests', p_consent, p_discounts, p_discount_reason);$new$);
  d := replace(d, $old$'tests', coalesce(array_length(p_test_ids, 1), 0)));$old$,
    $new$'tests', coalesce(array_length(p_test_ids, 1), 0), 'package_discount_pct', nullif(v_pkg_pct, 0)));$new$);
  if position('p_package_discount_pct numeric' in d) = 0 or position('v_pkg_pct numeric' in d) = 0 or position('p_consent, p_discounts, p_discount_reason)' in d) = 0
     or position('''package_discount_pct''' in d) = 0 then
    raise exception 'register_participant patch did not apply';
  end if;
  drop function public.register_participant(uuid, text, text, text, integer, text, text, text, text, boolean, uuid, text, uuid[]);
  execute d;
end $do$;

revoke execute on function public.create_addon_order(uuid, uuid, uuid[], text, boolean, jsonb, text),
  public.register_participant(uuid, text, text, text, integer, text, text, text, text, boolean, uuid, text, uuid[], jsonb, numeric, text)
  from public, anon;
grant execute on function public.create_addon_order(uuid, uuid, uuid[], text, boolean, jsonb, text),
  public.register_participant(uuid, text, text, text, integer, text, text, text, text, boolean, uuid, text, uuid[], jsonb, numeric, text)
  to authenticated;

-- receipts show the original price and the discount given to this patient
do $do$
declare d text;
begin
  d := pg_get_functiondef('public._issue_receipt(uuid)'::regprocedure);
  d := replace(d, $old$'unit_price_paise', oi.unit_price_paise, 'tax_paise', oi.tax_paise, 'quantity', oi.quantity))$old$,
    $new$'unit_price_paise', oi.unit_price_paise, 'tax_paise', oi.tax_paise, 'quantity', oi.quantity,
                      'list_price_paise', oi.list_price_paise, 'discount_pct', oi.discount_pct))$new$);
  d := replace(d, $old$'package', (select jsonb_build_object('name', pk.name, 'amount_paise', o.total_paise)$old$,
    $new$'package', (select jsonb_build_object('name', pk.name, 'amount_paise', o.total_paise,
                                             'list_paise', o.list_total_paise, 'discount_pct', o.discount_pct)$new$);
  d := replace(d, $old$      'event', e.name, 'issued_at', now())$old$,
    $new$      'discount_reason', (select discount_reason from orders where id = i.order_id),
      'event', e.name, 'issued_at', now())$new$);
  if position('''list_price_paise'', oi.list_price_paise' in d) = 0 or position('''list_paise'', o.list_total_paise' in d) = 0
     or position('''discount_reason'', (select' in d) = 0 then
    raise exception '_issue_receipt patch did not apply';
  end if;
  execute d;
end $do$;

-- finance reviewers can see orders (amounts, discounts, reasons) without participant access
create policy finance_view on public.orders for select to authenticated using (public.has_perm(event_id, 'finance.view'));
create policy finance_view on public.order_items for select to authenticated using (public.has_perm(event_id, 'finance.view'));
