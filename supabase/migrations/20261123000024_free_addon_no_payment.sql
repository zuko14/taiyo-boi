-- ---------------------------------------------------------------- free tests (active ₹0 price)
-- A free test never waits for the payment of other tests bought with it (₹0 lines cannot require payment).
do $do$
declare d text;
begin
  d := pg_get_functiondef('public.create_addon_order(uuid,uuid,uuid[],text,boolean)'::regprocedure);
  d := replace(d, $old$bool_or(l.require_payment) as req$old$, $new$bool_or(l.require_payment and l.price + coalesce(l.tax, 0) > 0) as req$new$);
  if position('l.price + coalesce(l.tax, 0) > 0' in d) = 0 then raise exception 'create_addon_order patch did not apply'; end if;
  execute d;
end $do$;
