-- Add-on orders, payment verification, receipts, refunds; reports; participant portal.

-- ---------------------------------------------------------------- add-on orders
create or replace function public.create_addon_order(
  p_reg uuid, p_desk uuid, p_test_ids uuid[], p_idempotency_key text, p_consent boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r registrations; s stations; v_snap jsonb; v_order uuid; v_intent uuid; v_total bigint;
  v_existing orders; grp record; v_task uuid; v_bad text;
begin
  perform public._lock_event((select event_id from registrations where id = p_reg));
  select * into r from registrations where id = p_reg;
  if not found or r.status <> 'active' then raise exception 'registration_inactive'; end if;
  s := public.assert_on_duty(p_desk, array['addon_desk']);
  if s.event_id <> r.event_id then raise exception 'invalid_station'; end if;
  perform public.require_perm(r.event_id, 'addon.create');
  perform public.assert_event_live(r.event_id);
  if coalesce(btrim(p_idempotency_key), '') = '' then raise exception 'idempotency_key_required'; end if;

  select * into v_existing from orders where registration_id = r.id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('order_id', v_existing.id, 'already', true,
      'intent_id', (select id from payment_intents where order_id = v_existing.id));
  end if;
  if not coalesce(p_consent, false) then raise exception 'consent_required: participant must confirm the tests and price'; end if;
  if coalesce(array_length(p_test_ids, 1), 0) = 0 then raise exception 'no_tests_selected'; end if;

  select snapshot into v_snap from package_configuration_versions where id = r.package_version_id;

  create temp table if not exists _addon_lines (test_id uuid, code text, name text, location text,
    price bigint, tax bigint, require_payment boolean, service_id uuid) on commit drop;
  delete from _addon_lines where true;
  insert into _addon_lines
  select t.id, t.code, t.display_name, t.location, ap.price_paise, ap.tax_paise,
         ap.require_payment_before_service, wst.service_id
    from (select distinct unnest(p_test_ids) as id) x
    join test_catalog t on t.id = x.id and t.event_id = r.event_id
    left join lateral (select * from addon_prices a
                        where a.test_id = t.id and a.active and a.effective_from <= now()
                          and (a.effective_to is null or a.effective_to > now())
                          and (a.location_scope = 'both' or a.location_scope = t.location)
                        order by a.effective_from desc limit 1) ap on true
    left join workflow_service_tests wst on wst.test_id = t.id;

  if (select count(*) from _addon_lines) <> (select count(distinct x) from unnest(p_test_ids) x) then
    raise exception 'invalid_test';
  end if;
  select string_agg(l.name, ', ') into v_bad from _addon_lines l
   where exists (select 1 from jsonb_array_elements(v_snap->'tests') y where (y->>'test_id')::uuid = l.test_id);
  if v_bad is not null then raise exception 'included_in_package: % already included in the sponsored package', v_bad; end if;
  select string_agg(l.name, ', ') into v_bad from _addon_lines l join test_catalog t on t.id = l.test_id
   where not t.active or t.archived or not t.addon_available;
  if v_bad is not null then raise exception 'not_available_as_addon: %', v_bad; end if;
  select string_agg(name, ', ') into v_bad from _addon_lines where price is null;
  if v_bad is not null then raise exception 'price_missing: %', v_bad; end if;
  select string_agg(name, ', ') into v_bad from _addon_lines where service_id is null;
  if v_bad is not null then raise exception 'config_invalid: no workflow service for %', v_bad; end if;
  select string_agg(l.name, ', ') into v_bad from _addon_lines l
   where exists (select 1 from order_items oi join orders o on o.id = oi.order_id
                  where oi.registration_id = r.id and oi.test_id = l.test_id and oi.status = 'active'
                    and o.status = 'active');
  if v_bad is not null then raise exception 'already_ordered: %', v_bad; end if;

  select sum(price + tax) into v_total from _addon_lines;
  insert into orders (event_id, registration_id, kind, total_paise, idempotency_key, consent_at, desk_station_id, created_by)
  values (r.event_id, r.id, 'addon', v_total, p_idempotency_key, now(), s.id, auth.uid()) returning id into v_order;
  if v_total > 0 then
    insert into payment_intents (event_id, order_id, registration_id, amount_paise, created_by)
    values (r.event_id, v_order, r.id, v_total, auth.uid()) returning id into v_intent;
  end if;

  for grp in
    select l.service_id, l.location, bool_or(l.require_payment) as req, ws.name as svc_name, ws.priority
      from _addon_lines l join workflow_services ws on ws.id = l.service_id
     group by l.service_id, l.location, ws.name, ws.priority
  loop
    insert into participant_tasks (event_id, registration_id, service_id, service_name, location, source,
                                   status, priority, payment_intent_id)
    values (r.event_id, r.id, grp.service_id, grp.svc_name, grp.location, 'addon',
            case grp.location when 'walk_in' then 'not_attended' else 'not_ready' end, grp.priority,
            case when grp.req and v_intent is not null then v_intent end)
    returning id into v_task;
    with ins as (
      insert into order_items (event_id, order_id, registration_id, test_id, test_code, test_name, location,
                               source, responsibility, unit_price_paise, tax_paise)
      select r.event_id, v_order, r.id, test_id, code, name, location, 'addon', 'employee', price, tax
        from _addon_lines where service_id = grp.service_id and location = grp.location
      returning id)
    insert into task_items (task_id, order_item_id) select v_task, id from ins;
    insert into task_status_history (event_id, task_id, to_status, actor_id, source)
    select r.event_id, v_task, status, auth.uid(), 'addon' from participant_tasks where id = v_task;
  end loop;

  perform public.write_audit(r.event_id, 'addon.create', 'order', v_order::text, null,
    jsonb_build_object('total_paise', v_total, 'tests', (select jsonb_agg(code) from _addon_lines)));
  perform public._schedule_next(r.id);
  return jsonb_build_object('order_id', v_order, 'intent_id', v_intent, 'total_paise', v_total, 'already', false);
end $$;

create or replace function public._issue_receipt(p_intent uuid) returns text
language plpgsql security definer set search_path = public as $$
declare i payment_intents; e events; v_no text; v_seq int;
begin
  select * into i from payment_intents where id = p_intent;
  select receipt_no into v_no from receipts where intent_id = p_intent;
  if v_no is not null then return v_no; end if;
  update events set receipt_seq = receipt_seq + 1 where id = i.event_id returning * into e;
  v_no := 'RCPT-' || e.code || '-' || lpad(e.receipt_seq::text, 6, '0');
  insert into receipts (event_id, intent_id, receipt_no, issued_by, snapshot)
  select i.event_id, i.id, v_no, auth.uid(), jsonb_build_object(
      'registration_code', r.registration_code, 'participant', p.full_name,
      'amount_paise', i.amount_paise, 'currency', i.currency,
      'method', (select method from payment_transactions where intent_id = i.id and status = 'verified'),
      'reference', (select provider_ref from payment_transactions where intent_id = i.id and status = 'verified'),
      'items', (select jsonb_agg(jsonb_build_object('name', oi.test_name, 'code', oi.test_code,
                      'unit_price_paise', oi.unit_price_paise, 'tax_paise', oi.tax_paise, 'quantity', oi.quantity))
                  from order_items oi where oi.order_id = i.order_id),
      'event', e.name, 'issued_at', now())
    from registrations r join participants p on p.id = r.participant_id where r.id = i.registration_id;
  return v_no;
end $$;

-- Manual verification by an authorised cashier using provider/settlement evidence.
-- Never collects UPI PINs / card data. A displayed QR or screenshot is not a payment.
create or replace function public.verify_payment(
  p_intent uuid, p_method text, p_provider_ref text, p_amount_paise bigint, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i payment_intents; v_methods jsonb; v_ref text := nullif(btrim(p_provider_ref), ''); v_receipt text; v_reg uuid;
begin
  perform public._lock_event((select event_id from payment_intents where id = p_intent));
  select * into i from payment_intents where id = p_intent for update;
  if not found then raise exception 'not_found: payment'; end if;
  perform public.require_perm(i.event_id, 'payment.verify');
  v_methods := coalesce(public.event_setting(i.event_id, 'payment_methods'), '[]');
  if not (v_methods ? p_method) then
    raise exception 'method_not_configured: % is not an approved payment method for this event', p_method;
  end if;
  if coalesce((public.event_setting(i.event_id, 'payment_maker_checker'))::boolean, true)
     and i.created_by = auth.uid() then
    raise exception 'maker_checker: the person who created the add-on order cannot verify its payment';
  end if;

  if i.status = 'paid' then
    if exists (select 1 from payment_transactions where intent_id = i.id and status = 'verified'
               and provider_ref is not distinct from v_ref and method = p_method) then
      return jsonb_build_object('ok', true, 'already', true, 'status', 'paid',
                                'receipt_no', (select receipt_no from receipts where intent_id = i.id));
    end if;
    raise exception 'already_paid';
  end if;
  if i.status not in ('pending','requires_review') then raise exception 'illegal_transition: payment is %', i.status; end if;
  if p_method <> 'cash' and v_ref is null then raise exception 'reference_required'; end if;

  if v_ref is not null and exists (select 1 from payment_transactions where event_id = i.event_id
       and method = p_method and provider_ref = v_ref and status = 'verified') then
    insert into payment_transactions (event_id, intent_id, method, provider_ref, amount_paise, status, note, verified_by)
    values (i.event_id, i.id, p_method, v_ref, p_amount_paise, 'rejected', 'duplicate reference', auth.uid());
    update payment_intents set status = 'requires_review', status_reason = 'Duplicate transaction reference',
           updated_at = now() where id = i.id;
    perform public.write_audit(i.event_id, 'payment.requires_review', 'payment_intent', i.id::text,
      'duplicate reference', '{}');
    return jsonb_build_object('ok', false, 'status', 'requires_review', 'reason', 'duplicate_reference');
  end if;
  if p_amount_paise <> i.amount_paise then
    insert into payment_transactions (event_id, intent_id, method, provider_ref, amount_paise, status, note, verified_by)
    values (i.event_id, i.id, p_method, v_ref, p_amount_paise, 'rejected', 'amount mismatch', auth.uid());
    update payment_intents set status = 'requires_review', status_reason = 'Amount mismatch', updated_at = now()
     where id = i.id;
    perform public.write_audit(i.event_id, 'payment.requires_review', 'payment_intent', i.id::text,
      'amount mismatch', jsonb_build_object('expected', i.amount_paise, 'received', p_amount_paise));
    return jsonb_build_object('ok', false, 'status', 'requires_review', 'reason', 'amount_mismatch');
  end if;

  insert into payment_transactions (event_id, intent_id, method, provider_ref, amount_paise, status, note, verified_by)
  values (i.event_id, i.id, p_method, v_ref, p_amount_paise, 'verified', p_note, auth.uid());
  update payment_intents set status = 'paid', status_reason = null, updated_at = now() where id = i.id;
  v_receipt := public._issue_receipt(i.id);
  perform public.write_audit(i.event_id, 'payment.verify', 'payment_intent', i.id::text, p_note,
    jsonb_build_object('method', p_method, 'amount_paise', p_amount_paise, 'receipt', v_receipt));
  perform public._schedule_next(i.registration_id);
  return jsonb_build_object('ok', true, 'status', 'paid', 'receipt_no', v_receipt);
end $$;

create or replace function public.payment_action(p_intent uuid, p_action text, p_reason text,
                                                 p_amount_paise bigint default null, p_provider_ref text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i payment_intents; v_new text; v_paid bigint;
begin
  perform public._lock_event((select event_id from payment_intents where id = p_intent));
  select * into i from payment_intents where id = p_intent for update;
  if not found then raise exception 'not_found: payment'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  perform set_config('app.reason', p_reason, true);

  if p_action = 'fail' then
    perform public.require_perm(i.event_id, 'payment.verify');
    if i.status not in ('pending','requires_review') then raise exception 'illegal_transition: payment is %', i.status; end if;
    insert into payment_transactions (event_id, intent_id, method, amount_paise, status, note, verified_by)
    values (i.event_id, i.id, 'n/a', 0, 'failed', p_reason, auth.uid());
    v_new := 'failed';
  elsif p_action = 'cancel' then
    perform public.require_perm(i.event_id, 'addon.create');
    if i.status not in ('pending','failed','requires_review') then
      raise exception 'illegal_transition: paid add-ons must be refunded, not cancelled';
    end if;
    v_new := 'cancelled';
  elsif p_action = 'reopen' then
    perform public.require_perm(i.event_id, 'payment.verify');
    if i.status not in ('failed','requires_review') then raise exception 'illegal_transition: payment is %', i.status; end if;
    v_new := 'pending';
  elsif p_action = 'waive' then
    perform public.require_perm(i.event_id, 'payment.waive');
    if i.status not in ('pending','requires_review','failed') then raise exception 'illegal_transition: payment is %', i.status; end if;
    v_new := 'waived';
  elsif p_action = 'refund' then
    perform public.require_perm(i.event_id, 'payment.refund');
    if i.status not in ('paid','partially_refunded') then raise exception 'illegal_transition: payment is %', i.status; end if;
    if p_amount_paise is null or p_amount_paise <= 0 or p_amount_paise > i.amount_paise - i.refunded_paise then
      raise exception 'invalid_amount';
    end if;
    insert into refunds (event_id, intent_id, amount_paise, reason, provider_ref, actor_id)
    values (i.event_id, i.id, p_amount_paise, p_reason, nullif(btrim(p_provider_ref), ''), auth.uid());
    v_paid := i.refunded_paise + p_amount_paise;
    update payment_intents set refunded_paise = v_paid where id = i.id;
    v_new := case when v_paid = i.amount_paise then 'refunded' else 'partially_refunded' end;
  else
    raise exception 'invalid_action';
  end if;

  update payment_intents set status = v_new, status_reason = p_reason, updated_at = now() where id = i.id;
  -- cancelled / fully refunded add-ons: unstarted tasks are cancelled; performed work stays recorded
  if v_new in ('cancelled','refunded') then
    update order_items set status = 'cancelled' where order_id = i.order_id and status = 'active'
       and not exists (select 1 from task_items ti join participant_tasks t on t.id = ti.task_id
                        where ti.order_item_id = order_items.id and t.status in ('in_service','completed','checked_in'));
    update queue_assignments q set state = 'cancelled', ended_at = now()
      from participant_tasks t where q.task_id = t.id and t.payment_intent_id = i.id and q.state in ('queued','called');
    perform public._set_task_status(t.id, 'cancelled', 'Add-on ' || v_new || ': ' || p_reason, 'system', null)
       from participant_tasks t
      where t.source = 'addon' and t.status in ('not_ready','waiting_unassigned','queued','called','not_attended')
        and exists (select 1 from task_items ti join order_items oi on oi.id = ti.order_item_id
                     where ti.task_id = t.id and oi.order_id = i.order_id);
    if v_new = 'cancelled' then update orders set status = 'cancelled' where id = i.order_id; end if;
  end if;
  perform public.write_audit(i.event_id, 'payment.' || p_action, 'payment_intent', i.id::text, p_reason,
    jsonb_build_object('from', i.status, 'to', v_new, 'amount_paise', p_amount_paise));
  perform public._schedule_next(i.registration_id);
  return jsonb_build_object('ok', true, 'status', v_new);
end $$;

-- ---------------------------------------------------------------- reports
create or replace function public.report_create(
  p_order_item uuid, p_title text, p_file_name text, p_mime text, p_size int, p_checksum text,
  p_accession text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare oi order_items; v_id uuid := gen_random_uuid(); v_version int; v_key text; v_status text := 'uploading';
        v_reason text; v_expected text;
begin
  select * into oi from order_items where id = p_order_item;
  if not found then raise exception 'not_found: order item'; end if;
  perform public.require_perm(oi.event_id, 'report.upload');
  if oi.status <> 'active' then raise exception 'order_item_cancelled'; end if;
  if (select status from registrations where id = oi.registration_id) <> 'active' then
    raise exception 'registration_inactive';
  end if;
  if p_checksum !~ '^[0-9a-f]{64}$' then raise exception 'invalid_checksum'; end if;
  select coalesce(oi.external_accession, max(t.external_accession)) into v_expected
    from task_items ti join participant_tasks t on t.id = ti.task_id where ti.order_item_id = oi.id;
  if nullif(btrim(p_accession), '') is not null and v_expected is not null and btrim(p_accession) <> v_expected then
    v_status := 'requires_review';
    v_reason := 'Accession/reference does not match the recorded value for this test';
  end if;
  select coalesce(max(version), 0) + 1 into v_version from reports where order_item_id = oi.id;
  v_key := oi.event_id || '/' || oi.registration_id || '/' || v_id || '.' ||
           case p_mime when 'application/pdf' then 'pdf' when 'image/png' then 'png' else 'jpg' end;
  insert into reports (id, event_id, registration_id, order_item_id, title, storage_key, file_name, mime_type,
                       size_bytes, checksum_sha256, version, accession_ref, status, status_reason, uploaded_by,
                       replaces_report_id)
  values (v_id, oi.event_id, oi.registration_id, oi.id, btrim(p_title), v_key, p_file_name, p_mime, p_size,
          p_checksum, v_version, nullif(btrim(p_accession), ''), v_status, v_reason, auth.uid(),
          (select id from reports where order_item_id = oi.id and status = 'published'));
  perform public.write_audit(oi.event_id, 'report.create', 'report', v_id::text, v_reason,
    jsonb_build_object('order_item', oi.id, 'version', v_version, 'checksum', p_checksum));
  return jsonb_build_object('report_id', v_id, 'storage_key', v_key, 'status', v_status);
end $$;

create or replace function public.report_action(p_report uuid, p_action text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rp reports; v_new text; v_maker boolean;
begin
  select * into rp from reports where id = p_report for update;
  if not found then raise exception 'not_found: report'; end if;
  v_maker := coalesce((public.event_setting(rp.event_id, 'report_maker_checker'))::boolean, true);

  if p_action = 'uploaded' then
    perform public.require_perm(rp.event_id, 'report.upload');
    if rp.status = 'requires_review' then return jsonb_build_object('ok', true, 'status', rp.status); end if;
    if rp.status <> 'uploading' then raise exception 'illegal_transition'; end if;
    v_new := 'uploaded_pending_validation';
  elsif p_action = 'upload_failed' then
    perform public.require_perm(rp.event_id, 'report.upload');
    if rp.status not in ('uploading','requires_review') then raise exception 'illegal_transition'; end if;
    v_new := 'upload_failed';
  elsif p_action = 'validate' then
    perform public.require_perm(rp.event_id, 'report.validate');
    if rp.status <> 'uploaded_pending_validation' then raise exception 'illegal_transition: report is %', rp.status; end if;
    if v_maker and rp.uploaded_by = auth.uid() then
      raise exception 'maker_checker: a different person must validate this report';
    end if;
    v_new := 'validated';
  elsif p_action = 'resolve_review' then
    perform public.require_perm(rp.event_id, 'report.validate');
    if rp.status <> 'requires_review' then raise exception 'illegal_transition'; end if;
    if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
    v_new := 'uploaded_pending_validation';
  elsif p_action = 'publish' then
    perform public.require_perm(rp.event_id, 'report.publish');
    if rp.status <> 'validated' then raise exception 'illegal_transition: only validated reports can be published'; end if;
    update reports set status = 'replaced' where order_item_id = rp.order_item_id and status = 'published';
    v_new := 'published';
  elsif p_action = 'withdraw' then
    perform public.require_perm(rp.event_id, 'report.withdraw');
    if rp.status not in ('published','validated','uploaded_pending_validation','requires_review') then
      raise exception 'illegal_transition';
    end if;
    if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
    v_new := 'withdrawn';
  else
    raise exception 'invalid_action';
  end if;

  update reports set status = v_new, status_reason = coalesce(p_reason, status_reason),
         validated_by = case when v_new = 'validated' then auth.uid() else validated_by end,
         validated_at = case when v_new = 'validated' then now() else validated_at end,
         published_by = case when v_new = 'published' then auth.uid() else published_by end,
         published_at = case when v_new = 'published' then now() else published_at end,
         withdrawn_by = case when v_new = 'withdrawn' then auth.uid() else withdrawn_by end,
         withdrawn_at = case when v_new = 'withdrawn' then now() else withdrawn_at end
   where id = rp.id;
  perform public.write_audit(rp.event_id, 'report.' || p_action, 'report', rp.id::text, p_reason,
    jsonb_build_object('from', rp.status, 'to', v_new));
  return jsonb_build_object('ok', true, 'status', v_new);
end $$;

-- ---------------------------------------------------------------- participant portal (service role only)
create or replace function public.portal_registration(p_token_hash text) returns uuid
language sql stable security definer set search_path = public as $$
  select r.id from registration_tokens k join registrations r on r.id = k.registration_id
   where k.token_hash = p_token_hash and k.revoked_at is null and r.status = 'active'
$$;

create or replace function public.portal_view(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_reg uuid := public.portal_registration(p_token_hash); v jsonb;
begin
  if v_reg is null then return null; end if;
  select jsonb_build_object(
    'event', jsonb_build_object('name', e.name, 'venue', e.venue, 'help', e.help_contact,
                                'instructions', e.portal_instructions, 'timezone', e.timezone,
                                'lab_partner', e.lab_partner_name, 'status', e.status),
    'registration', jsonb_build_object('code', r.registration_code, 'first_name', split_part(p.full_name, ' ', 1),
                                       'package', pk.name, 'classification', r.classification,
                                       'created_at', r.created_at, 'has_mobile', p.mobile is not null),
    'next_step', (select jsonb_build_object('task_id', t.id, 'service', t.service_name, 'station', s.name,
                         'station_code', s.code, 'location', s.location, 'instructions', s.instructions,
                         'state', q.state, 'seq', q.seq,
                         'ahead', (select count(*) from queue_assignments q2 where q2.station_id = q.station_id
                                    and q2.state = 'queued' and q2.seq < q.seq))
                    from queue_assignments q join participant_tasks t on t.id = q.task_id
                    join stations s on s.id = q.station_id
                   where q.registration_id = r.id and q.state in ('queued','called','in_service') limit 1),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', t.id, 'service', t.service_name, 'location', t.location, 'source', t.source,
                 'status', t.status, 'choice_group_id', t.choice_group_id,
                 'items', (select jsonb_agg(jsonb_build_object('id', oi.id, 'name', oi.test_name,
                             'report', coalesce((select case rp.status when 'published' then 'available'
                                        when 'withdrawn' then 'not_uploaded' else 'processing' end
                                        from reports rp where rp.order_item_id = oi.id
                                        and rp.status not in ('replaced','upload_failed')
                                        order by (rp.status = 'published') desc, rp.version desc limit 1), 'not_uploaded'))
                             order by oi.test_name)
                             from task_items ti join order_items oi on oi.id = ti.order_item_id
                            where ti.task_id = t.id and oi.status = 'active'))
               order by t.location, t.source, t.priority, t.service_name)
             from participant_tasks t where t.registration_id = r.id and t.status <> 'cancelled'), '[]'::jsonb),
    'walkin_centres', coalesce((select jsonb_agg(distinct jsonb_build_object('name', s.name, 'address', s.address,
                 'hours', s.operating_hours, 'instructions', s.instructions,
                 'valid_from', s.valid_from, 'valid_to', s.valid_to))
             from participant_tasks t join station_capabilities sc on sc.service_id = t.service_id
             join stations s on s.id = sc.station_id and s.kind = 'walkin_centre'
            where t.registration_id = r.id and t.location = 'walk_in' and t.status <> 'cancelled'), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('status', i.status, 'amount_paise', i.amount_paise,
                 'refunded_paise', i.refunded_paise, 'receipt_no', rc.receipt_no,
                 'items', (select jsonb_agg(oi.test_name) from order_items oi where oi.order_id = i.order_id))
               order by i.created_at)
             from payment_intents i left join receipts rc on rc.intent_id = i.id
            where i.registration_id = r.id and i.status <> 'cancelled'), '[]'::jsonb),
    'choice_groups', (select pcv.snapshot->'choice_groups' from package_configuration_versions pcv where pcv.id = r.package_version_id),
    'choice_options', (select jsonb_agg(jsonb_build_object('group', y->>'choice_group_id', 'name', y->>'name'))
                         from package_configuration_versions pcv, jsonb_array_elements(pcv.snapshot->'tests') y
                        where pcv.id = r.package_version_id and y->>'choice_group_id' is not null))
  into v
  from registrations r join participants p on p.id = r.participant_id
  join events e on e.id = r.event_id join packages pk on pk.id = r.package_id
  where r.id = v_reg;
  return v;
end $$;

-- returns the mobile number (server sends the OTP via the configured adapter); rate limited
create or replace function public.portal_otp_request(p_token_hash text, p_code_hash text) returns text
language plpgsql security definer set search_path = public as $$
declare v_reg uuid := public.portal_registration(p_token_hash); v_mobile text;
begin
  if v_reg is null then raise exception 'invalid_token'; end if;
  select p.mobile into v_mobile from registrations r join participants p on p.id = r.participant_id where r.id = v_reg;
  if v_mobile is null then raise exception 'no_mobile: please contact the help desk'; end if;
  if (select count(*) from portal_otps where registration_id = v_reg and created_at > now() - interval '15 minutes') >= 3 then
    raise exception 'rate_limited: too many codes requested, try again later';
  end if;
  insert into portal_otps (registration_id, code_hash, expires_at) values (v_reg, p_code_hash, now() + interval '5 minutes');
  return v_mobile;
end $$;

create or replace function public.portal_otp_verify(p_token_hash text, p_code_hash text, p_session_hash text) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_reg uuid := public.portal_registration(p_token_hash); o portal_otps;
begin
  if v_reg is null then return false; end if;
  select * into o from portal_otps where registration_id = v_reg and consumed_at is null and expires_at > now()
   order by created_at desc limit 1 for update;
  if o.id is null or o.attempts >= 5 then return false; end if;
  if o.code_hash <> p_code_hash then
    update portal_otps set attempts = attempts + 1 where id = o.id;
    return false;
  end if;
  update portal_otps set consumed_at = now() where id = o.id;
  insert into portal_sessions (registration_id, session_hash, expires_at) values (v_reg, p_session_hash, now() + interval '30 minutes');
  insert into audit_logs (event_id, action, entity_type, entity_id)
  select event_id, 'portal.verified', 'registration', id::text from registrations where id = v_reg;
  return true;
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
  return query select rp.id, rp.title, oi.test_name, rp.version, rp.published_at, rp.storage_key, rp.mime_type
    from reports rp join order_items oi on oi.id = rp.order_item_id
   where rp.registration_id = v_reg and rp.status = 'published' order by oi.test_name;
end $$;

create or replace function public.portal_log_download(p_token_hash text, p_report uuid) returns void
language sql security definer set search_path = public as $$
  insert into audit_logs (event_id, action, entity_type, entity_id)
  select event_id, 'report.participant_download', 'report', id::text from reports where id = p_report
$$;
