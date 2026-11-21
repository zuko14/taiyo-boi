-- Package CSV import (custom camps). One row per package test; the file is the full contents of each
-- package it names: packages are created or updated by code, and their plain test list is replaced
-- (choice-group options are untouched). Tests are matched by catalogue code or exact name and must be
-- active and linked to a visit. All or nothing.
-- p_rows: [{package_code, package_name, code_letter, price_paise|null, description, test}]

create or replace function public.import_packages(p_event uuid, p_rows jsonb, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  pk record; x jsonb; v_pkg packages; v_test test_catalog; v_ids uuid[]; v_letter text;
  n_new int := 0; n_upd int := 0; n_tests int := 0;
begin
  perform public._lock_event(p_event);
  perform public.require_perm(p_event, 'package.edit');
  perform public.require_perm(p_event, 'package.test_mapping.edit');
  if public.package_mode(p_event) <> 'custom' then
    raise exception 'package_mode: this event uses the fixed Female/Male packages';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'invalid_import: no rows'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'invalid_import: at most 5000 rows per upload'; end if;
  perform set_config('app.reason', coalesce(nullif(btrim(p_reason), ''), 'Package CSV import'), true);

  for pk in
    select upper(btrim(y->>'package_code')) as code,
           max(nullif(btrim(y->>'package_name'), '')) as name,
           max(nullif(upper(btrim(y->>'code_letter')), '')) as letter,
           max((y->>'price_paise')::bigint) as price, bool_or(y ? 'price_paise' and y->>'price_paise' is not null) as has_price,
           max(nullif(btrim(y->>'description'), '')) as description,
           count(distinct (y->>'price_paise')) filter (where y->>'price_paise' is not null) as n_prices
      from jsonb_array_elements(p_rows) y group by 1 order by 1
  loop
    if pk.code !~ '^[A-Z0-9_]{1,30}$' then raise exception 'invalid_import: package code "%" (A–Z, 0–9 and _, max 30)', pk.code; end if;
    if pk.code = 'PAY_PER_TEST' then raise exception 'invalid_import: the Pay per test package cannot be imported'; end if;
    if pk.n_prices > 1 then raise exception 'invalid_import: package % has different prices on different rows', pk.code; end if;
    select * into v_pkg from packages where event_id = p_event and code = pk.code;
    if v_pkg.id is null then
      if pk.name is null then raise exception 'invalid_import: new package % needs a package_name', pk.code; end if;
      v_letter := coalesce(pk.letter, (select l from unnest(string_to_array('A,B,C,D,E,G,H,J,K,L,N,P,Q,R,S,U,V,W,X,Y,Z', ',')) l
                                        where not exists (select 1 from packages where event_id = p_event and code_letter = l) limit 1));
      if v_letter is null or v_letter !~ '^[A-Z]{1,3}$' then raise exception 'invalid_import: package % needs a code_letter (1–3 letters)', pk.code; end if;
      insert into packages (event_id, classification, code, name, code_letter, description, price_paise)
      values (p_event, lower(pk.code), pk.code, pk.name, v_letter, coalesce(pk.description, ''), nullif(pk.price, 0))
      returning * into v_pkg;
      n_new := n_new + 1;
    else
      update packages set name = coalesce(pk.name, name), description = coalesce(pk.description, description),
             code_letter = coalesce(pk.letter, code_letter),
             price_paise = case when pk.has_price then nullif(pk.price, 0) else price_paise end
       where id = v_pkg.id;
      n_upd := n_upd + 1;
    end if;

    v_ids := '{}';
    for x in select y from jsonb_array_elements(p_rows) y where upper(btrim(y->>'package_code')) = pk.code loop
      continue when coalesce(btrim(x->>'test'), '') = '';
      select * into v_test from test_catalog
       where event_id = p_event and (code = upper(btrim(x->>'test')) or lower(display_name) = lower(btrim(x->>'test')))
       order by (code = upper(btrim(x->>'test'))) desc limit 1;
      if v_test.id is null then raise exception 'invalid_import: package % — test "%" is not in the catalogue', pk.code, btrim(x->>'test'); end if;
      if not v_test.active or v_test.archived then raise exception 'invalid_import: package % — test "%" is inactive or archived', pk.code, v_test.display_name; end if;
      if not exists (select 1 from workflow_service_tests where test_id = v_test.id) then
        raise exception 'invalid_import: package % — test "%" is not linked to a visit (set it in the Test catalogue)', pk.code, v_test.display_name;
      end if;
      v_ids := array_append(v_ids, v_test.id);
    end loop;

    delete from package_tests where package_id = v_pkg.id and choice_group_id is null and not (test_id = any (v_ids));
    insert into package_tests (event_id, package_id, test_id)
    select p_event, v_pkg.id, t from (select distinct unnest(v_ids) t) q
     where not exists (select 1 from package_tests where package_id = v_pkg.id and test_id = q.t);
    n_tests := n_tests + coalesce(array_length(array(select distinct unnest(v_ids)), 1), 0);
  end loop;

  perform public.write_audit(p_event, 'package.import', 'package', null, p_reason,
    jsonb_build_object('created', n_new, 'updated', n_upd, 'tests', n_tests));
  return jsonb_build_object('created', n_new, 'updated', n_upd, 'tests', n_tests);
end $$;

revoke execute on function public.import_packages(uuid, jsonb, text) from public, anon;
grant execute on function public.import_packages(uuid, jsonb, text) to authenticated;
