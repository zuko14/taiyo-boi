-- The automatic "Pay per test" package must stay empty and free: a tests-only patient gets exactly
-- the tests picked at the desk. A test or a price added to it would be forced on every such patient.
-- Existing registrations keep their own snapshot; only future registrations are affected.

create or replace function public.pay_per_test_guard() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from packages where id = new.package_id and code = 'PAY_PER_TEST') then
    raise exception 'package_mode: the Pay per test package has no tests of its own — tests-only patients get only the tests picked at registration';
  end if;
  return new;
end $$;
create trigger pay_per_test_guard before insert or update of package_id on public.package_tests
  for each row execute function public.pay_per_test_guard();

do $do$
declare d text;
begin
  d := pg_get_functiondef('public.set_package_rate(uuid,bigint,text)'::regprocedure);
  d := replace(d, $old$  if p_amount_paise < 0 then raise exception 'invalid_amount'; end if;$old$,
    $new$  if pk.code = 'PAY_PER_TEST' and coalesce(p_amount_paise, 0) > 0 then
    raise exception 'package_mode: the Pay per test package is always free — patients pay for the tests they pick';
  end if;
  if p_amount_paise < 0 then raise exception 'invalid_amount'; end if;$new$);
  if position('always free' in d) = 0 then raise exception 'set_package_rate patch did not apply'; end if;
  execute d;
end $do$;

-- clean up anything already added by mistake (audited by the config trigger)
delete from public.package_tests pt using public.packages p
 where p.id = pt.package_id and p.code = 'PAY_PER_TEST';
delete from public.choice_groups g using public.packages p
 where p.id = g.package_id and p.code = 'PAY_PER_TEST';
update public.packages set price_paise = null where code = 'PAY_PER_TEST' and price_paise is not null;

revoke execute on function public.pay_per_test_guard() from public, anon, authenticated;
