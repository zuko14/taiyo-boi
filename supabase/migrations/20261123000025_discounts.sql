-- Discounts on tests and packages.
-- The charged price stays in price_paise (orders, payments, receipts and revenue are unchanged);
-- mrp_paise + discount_pct record the original price and the discount it was derived from.
-- The database guarantees: price = round(mrp × (100 − discount%) / 100).

alter table public.addon_prices
  add column mrp_paise bigint check (mrp_paise >= 0),
  add column discount_pct numeric(5,2) not null default 0 check (discount_pct >= 0 and discount_pct <= 100),
  add constraint addon_prices_discount_needs_mrp check (discount_pct = 0 or mrp_paise is not null),
  add constraint addon_prices_discount_math check (mrp_paise is null or price_paise = round(mrp_paise * (100 - discount_pct) / 100));

alter table public.packages
  add column mrp_paise bigint check (mrp_paise >= 0),
  add column discount_pct numeric(5,2) not null default 0 check (discount_pct >= 0 and discount_pct <= 100),
  add constraint packages_discount_needs_mrp check (discount_pct = 0 or mrp_paise is not null),
  add constraint packages_discount_math check (mrp_paise is null or coalesce(price_paise, 0) = round(mrp_paise * (100 - discount_pct) / 100));

-- package price: p_amount_paise is the original price; the participant pays it minus the discount
drop function if exists public.set_package_rate(uuid, bigint, text);
create or replace function public.set_package_rate(p_package uuid, p_amount_paise bigint, p_reason text default null, p_discount_pct numeric default 0)
returns void language plpgsql security definer set search_path = public as $$
declare pk packages; v_pct numeric(5,2) := coalesce(p_discount_pct, 0); v_final bigint;
begin
  select * into pk from packages where id = p_package;
  if pk.id is null then raise exception 'not_found: package'; end if;
  perform public.require_perm(pk.event_id, 'package.edit');
  if public.package_mode(pk.event_id) <> 'custom' then raise exception 'package_mode: rate is backend-only for this event'; end if;
  if pk.code = 'PAY_PER_TEST' and coalesce(p_amount_paise, 0) > 0 then
    raise exception 'package_mode: the Pay per test package is always free — patients pay for the tests they pick';
  end if;
  if p_amount_paise < 0 then raise exception 'invalid_amount'; end if;
  if v_pct < 0 or v_pct > 100 then raise exception 'invalid_amount: discount must be between 0 and 100%%'; end if;
  if v_pct > 0 and coalesce(p_amount_paise, 0) = 0 then raise exception 'invalid_amount: set the package price before a discount'; end if;
  if p_reason is not null then perform set_config('app.reason', p_reason, true); end if;
  v_final := round(coalesce(p_amount_paise, 0) * (100 - v_pct) / 100);
  -- existing registrations keep the amount on their own package order / payment
  update packages set price_paise = nullif(v_final, 0),
         mrp_paise = case when v_pct > 0 then p_amount_paise end, discount_pct = v_pct
   where id = pk.id;
  perform public.write_audit(pk.event_id, 'package.rate', 'package', pk.id::text, null,
    jsonb_build_object('amount_paise', v_final, 'mrp_paise', p_amount_paise, 'discount_pct', v_pct));
end $$;
revoke execute on function public.set_package_rate(uuid, bigint, text, numeric) from public, anon;
grant execute on function public.set_package_rate(uuid, bigint, text, numeric) to authenticated;

-- One discount for many tests (all priced tests when p_test_ids is null), optionally packages too.
-- 0% restores the original prices. Each change is a new price row; orders keep their snapshot.
create or replace function public.apply_discount(p_event uuid, p_discount_pct numeric, p_test_ids uuid[] default null,
                                                 p_include_packages boolean default false, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record; pk record; v_pct numeric(5,2) := coalesce(p_discount_pct, 0); v_base bigint; v_final bigint;
        n_tests int := 0; n_pkgs int := 0;
begin
  perform public._lock_event(p_event);
  perform public.require_perm(p_event, 'addon.price.edit');
  if v_pct < 0 or v_pct > 100 then raise exception 'invalid_amount: discount must be between 0 and 100%%'; end if;
  perform set_config('app.reason', coalesce(nullif(btrim(p_reason), ''), format('Discount %s%%', v_pct)), true);
  for a in select * from addon_prices
            where event_id = p_event and active and (effective_to is null or effective_to > now())
              and (p_test_ids is null or test_id = any (p_test_ids))
            order by test_id, created_at for update loop
    v_base := coalesce(a.mrp_paise, a.price_paise);
    continue when v_base = 0;                                  -- free tests stay free
    v_final := round(v_base * (100 - v_pct) / 100);
    continue when v_final = a.price_paise and a.discount_pct = v_pct;
    update addon_prices set active = false where id = a.id;
    insert into addon_prices (event_id, test_id, price_paise, tax_paise, currency, location_scope,
                              require_payment_before_service, effective_from, effective_to, mrp_paise, discount_pct)
    values (a.event_id, a.test_id, v_final, a.tax_paise, a.currency, a.location_scope, a.require_payment_before_service,
            greatest(a.effective_from, now()), a.effective_to, case when v_pct > 0 then v_base end, v_pct);
    n_tests := n_tests + 1;
  end loop;
  if p_include_packages then
    perform public.require_perm(p_event, 'package.edit');
    if public.package_mode(p_event) <> 'custom' then raise exception 'package_mode: package prices are backend-only for this event'; end if;
    for pk in select * from packages where event_id = p_event and coalesce(mrp_paise, price_paise, 0) > 0 for update loop
      v_base := coalesce(pk.mrp_paise, pk.price_paise);
      update packages set price_paise = nullif(round(v_base * (100 - v_pct) / 100), 0),
             mrp_paise = case when v_pct > 0 then v_base end, discount_pct = v_pct where id = pk.id;
      n_pkgs := n_pkgs + 1;
    end loop;
  end if;
  perform public.write_audit(p_event, 'price.discount', 'event', p_event::text, p_reason,
    jsonb_build_object('discount_pct', v_pct, 'tests', n_tests, 'packages', n_pkgs, 'scope', case when p_test_ids is null then 'all' else 'selected' end));
  return jsonb_build_object('tests', n_tests, 'packages', n_pkgs);
end $$;
revoke execute on function public.apply_discount(uuid, numeric, uuid[], boolean, text) from public, anon;
grant execute on function public.apply_discount(uuid, numeric, uuid[], boolean, text) to authenticated;
