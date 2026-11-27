-- Add-on desk: the same per-patient, per-test discount the registration desk has.
-- Only for an eligible person (reason required, audited, stored on the patient's own order lines);
-- catalogue prices and other patients are unchanged. Payment, receipt and revenue follow the discounted price.
insert into public.permissions (code, description) values
  ('addon.discount', 'Give a patient a discount on an add-on test at the add-on desk (reason required, audited)')
on conflict (code) do nothing;
insert into public.default_role_permissions (role_code, permission_code)
select r, 'addon.discount' from unnest(array['addon_staff','registration_supervisor','event_admin']) r
on conflict do nothing;
insert into public.role_permissions (event_id, role_code, permission_code)
select e.id, r, 'addon.discount' from public.events e, unnest(array['addon_staff','registration_supervisor','event_admin']) r
on conflict do nothing;

do $do$
declare d text;
begin
  d := pg_get_functiondef('public.create_addon_order(uuid,uuid,uuid[],text,boolean,jsonb,text,uuid,uuid,text)'::regprocedure);
  d := replace(d, $old$    perform public.require_perm(r.event_id, 'registration.discount');$old$,
    $new$    -- registration desk (registration.discount) or add-on desk (addon.discount)
    if not (public.has_perm(r.event_id, 'registration.discount') or public.has_perm(r.event_id, 'addon.discount')) then
      raise exception 'permission_denied: addon.discount' using errcode = '42501';
    end if;$new$);
  if position('addon.discount' in d) = 0 then raise exception 'create_addon_order patch did not apply'; end if;
  execute d;
end $do$;
