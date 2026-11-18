-- Participant-paid packages (custom events), package-aware receipts/portal/payment actions,
-- add-on-only revenue report, and the revenue insights read model.
--
-- A priced package creates, at registration, an active 'package' order carrying the price snapshot
-- and one payment intent. Every package task of that registration points at the intent, so the
-- existing gates apply unchanged: the scheduler does not queue it and the walk-in centre cannot
-- check it in until a cashier verifies the payment (or it is waived / a supervised exception).
-- Order lines stay ₹0 per test; the price belongs to the package as a whole.

-- ---------------------------------------------------------------- registration creates the payment
do $$
declare d text;
begin
  d := pg_get_functiondef('public.register_participant(uuid,text,text,text,int,text,text,text,text,boolean,uuid,text)'::regprocedure);
  d := replace(d, $old$v_snapshot jsonb; v_assign uuid;$old$, $new$v_snapshot jsonb; v_assign uuid; v_order uuid; v_intent uuid;$new$);
  d := replace(d, $old$  perform public._materialize_package(r.id, v_snapshot);$old$,
    $new$  if coalesce(pkg.price_paise, 0) > 0 then
    insert into orders (event_id, registration_id, kind, total_paise, created_by)
    values (e.id, r.id, 'package', pkg.price_paise, auth.uid()) returning id into v_order;
    insert into payment_intents (event_id, order_id, registration_id, amount_paise, created_by)
    values (e.id, v_order, r.id, pkg.price_paise, auth.uid()) returning id into v_intent;
  end if;
  perform public._materialize_package(r.id, v_snapshot);$new$);
  d := replace(d, $old$'already', false,
                            'assignment_id', v_assign);$old$,
    $new$'already', false,
                            'assignment_id', v_assign, 'payment_intent_id', v_intent);$new$);
  if position('v_intent' in d) = 0 or position('''payment_intent_id'', v_intent' in d) = 0 then
    raise exception 'register_participant patch did not apply';
  end if;
  execute d;
end $$;

-- every package task (including ones created later by a choice selection or config migration)
-- inherits the registration's package payment
create or replace function public.package_task_payment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'package' and new.payment_intent_id is null then
    select i.id into new.payment_intent_id
      from payment_intents i join orders o on o.id = i.order_id
     where o.registration_id = new.registration_id and o.kind = 'package' and o.status = 'active'
     order by i.created_at limit 1;
  end if;
  return new;
end $$;
create trigger package_task_payment before insert on public.participant_tasks
  for each row execute function public.package_task_payment();

-- ---------------------------------------------------------------- receipts and portal know the package
do $$
declare d text;
begin
  d := pg_get_functiondef('public._issue_receipt(uuid)'::regprocedure);
  d := replace(d, $old$      'event', e.name, 'issued_at', now())$old$,
    $new$      'package', (select jsonb_build_object('name', pk.name, 'amount_paise', o.total_paise)
                    from orders o join packages pk on pk.id = r.package_id
                   where o.id = i.order_id and o.kind = 'package'),
      'event', e.name, 'issued_at', now())$new$);
  if position('''package'', (select' in d) = 0 then raise exception '_issue_receipt patch did not apply'; end if;
  execute d;

  d := pg_get_functiondef('public.portal_view(text)'::regprocedure);
  d := replace(d, $old$'refunded_paise', i.refunded_paise, 'receipt_no', rc.receipt_no,$old$,
    $new$'refunded_paise', i.refunded_paise, 'receipt_no', rc.receipt_no,
                 'kind', (select o.kind from orders o where o.id = i.order_id),$new$);
  -- the lab's UPI collection details so participants can pay from their own phone
  d := replace(d, $old$'lab_partner', e.lab_partner_name, 'status', e.status),$old$,
    $new$'lab_partner', e.lab_partner_name, 'status', e.status,
                                'upi_vpa', e.settings->>'upi_vpa', 'upi_payee_name', e.settings->>'upi_payee_name'),$new$);
  if position('''kind'', (select o.kind' in d) = 0 or position('''upi_vpa''' in d) = 0 then raise exception 'portal_view patch did not apply'; end if;
  execute d;

  -- a package payment is not an add-on order: it cannot be cancelled (deactivate/correct the
  -- registration instead), and a refund leaves the package lines and tasks recorded
  d := pg_get_functiondef('public.payment_action(uuid,text,text,bigint,text)'::regprocedure);
  d := replace(d, $old$  elsif p_action = 'cancel' then
    perform public.require_perm(i.event_id, 'addon.create');$old$,
    $new$  elsif p_action = 'cancel' then
    perform public.require_perm(i.event_id, 'addon.create');
    if (select kind from orders where id = i.order_id) = 'package' then
      raise exception 'illegal_transition: a package payment cannot be cancelled — waive it (approved) or correct the registration';
    end if;$new$);
  d := replace(d, $old$  if v_new in ('cancelled','refunded') then$old$,
    $new$  if v_new in ('cancelled','refunded') and (select kind from orders where id = i.order_id) = 'addon' then$new$);
  if position('a package payment cannot be cancelled' in d) = 0
     or position($x$(select kind from orders where id = i.order_id) = 'addon' then$x$ in d) = 0 then
    raise exception 'payment_action patch did not apply';
  end if;
  execute d;
end $$;

-- ---------------------------------------------------------------- add-on revenue stays add-on only
create or replace function public.addon_revenue(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_perm(p_event, 'finance.view');
  return jsonb_build_object(
    'by_test', coalesce((select jsonb_agg(x order by x->>'name') from (
      select jsonb_build_object('code', oi.test_code, 'name', oi.test_name,
        'quantity', sum(oi.quantity),
        'unit_prices', array_agg(distinct oi.unit_price_paise),
        'gross_paise', sum((oi.unit_price_paise + oi.tax_paise) * oi.quantity),
        'tax_paise', sum(oi.tax_paise * oi.quantity),
        'paid_paise', sum((oi.unit_price_paise + oi.tax_paise) * oi.quantity) filter (where i.status in ('paid','partially_refunded','refunded')),
        'pending_paise', sum((oi.unit_price_paise + oi.tax_paise) * oi.quantity) filter (where i.status in ('pending','requires_review')),
        'failed_paise', sum((oi.unit_price_paise + oi.tax_paise) * oi.quantity) filter (where i.status = 'failed'),
        'waived_paise', sum((oi.unit_price_paise + oi.tax_paise) * oi.quantity) filter (where i.status = 'waived')) x
        from order_items oi join orders o on o.id = oi.order_id
        left join payment_intents i on i.order_id = o.id
       where oi.event_id = p_event and oi.source = 'addon' and o.status = 'active'
       group by oi.test_code, oi.test_name) q), '[]'),
    'totals', jsonb_build_object(
      'verified_received_paise', coalesce((select sum(pt.amount_paise) from payment_transactions pt
          join payment_intents i on i.id = pt.intent_id join orders o on o.id = i.order_id
         where pt.event_id = p_event and pt.status = 'verified' and o.kind = 'addon'), 0),
      'refunded_paise', coalesce((select sum(rf.amount_paise) from refunds rf
          join payment_intents i on i.id = rf.intent_id join orders o on o.id = i.order_id
         where rf.event_id = p_event and o.kind = 'addon'), 0),
      'pending_paise', coalesce((select sum(i.amount_paise) from payment_intents i join orders o on o.id = i.order_id
         where i.event_id = p_event and i.status in ('pending','requires_review') and o.kind = 'addon'), 0),
      'failed_paise', coalesce((select sum(i.amount_paise) from payment_intents i join orders o on o.id = i.order_id
         where i.event_id = p_event and i.status = 'failed' and o.kind = 'addon'), 0),
      'waived_paise', coalesce((select sum(i.amount_paise) from payment_intents i join orders o on o.id = i.order_id
         where i.event_id = p_event and i.status = 'waived' and o.kind = 'addon'), 0)),
    'by_method', coalesce((select jsonb_agg(jsonb_build_object('method', method, 'count', n, 'amount_paise', amt)) from (
      select pt.method, count(*) n, sum(pt.amount_paise) amt from payment_transactions pt
        join payment_intents i on i.id = pt.intent_id join orders o on o.id = i.order_id
       where pt.event_id = p_event and pt.status = 'verified' and o.kind = 'addon' group by pt.method) q), '[]'),
    'by_cashier', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'count', n, 'amount_paise', amt)) from (
      select coalesce(sp.full_name, 'unknown') name, count(*) n, sum(pt.amount_paise) amt from payment_transactions pt
        join payment_intents i on i.id = pt.intent_id join orders o on o.id = i.order_id
        left join staff_profiles sp on sp.user_id = pt.verified_by
       where pt.event_id = p_event and pt.status = 'verified' and o.kind = 'addon' group by 1) q), '[]'));
end $$;

-- ---------------------------------------------------------------- revenue insights (participant-paid money only)
-- Revenue = verified payment transactions minus refunds. Orders and displayed QRs are never revenue.
-- Sponsor package rates are not included (they are not participant payments).
create or replace function public.revenue_insights(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_tz text;
begin
  perform public.require_perm(p_event, 'finance.view');
  select timezone into v_tz from events where id = p_event;
  return jsonb_build_object(
    'totals', (select jsonb_build_object(
        'collected_paise', coalesce(sum(pt.amount_paise), 0),
        'payments', count(*),
        'paying_participants', count(distinct i.registration_id),
        'first_at', min(pt.created_at), 'last_at', max(pt.created_at))
       from payment_transactions pt join payment_intents i on i.id = pt.intent_id
      where pt.event_id = p_event and pt.status = 'verified'),
    'refunded_paise', coalesce((select sum(amount_paise) from refunds where event_id = p_event), 0),
    'open', (select jsonb_build_object(
        'pending_paise', coalesce(sum(amount_paise) filter (where status in ('pending','requires_review')), 0),
        'pending_count', count(*) filter (where status in ('pending','requires_review')),
        'review_count', count(*) filter (where status = 'requires_review'),
        'waived_paise', coalesce(sum(amount_paise) filter (where status = 'waived'), 0),
        'failed_paise', coalesce(sum(amount_paise) filter (where status = 'failed'), 0))
       from payment_intents where event_id = p_event),
    'by_source', coalesce((select jsonb_agg(jsonb_build_object('source', kind, 'collected_paise', c, 'pending_paise', pnd, 'payments', n) order by kind desc) from (
        select o.kind,
               coalesce((select sum(pt.amount_paise) from payment_transactions pt join payment_intents i2 on i2.id = pt.intent_id
                          join orders o2 on o2.id = i2.order_id where pt.event_id = p_event and pt.status = 'verified' and o2.kind = o.kind), 0)
               - coalesce((select sum(rf.amount_paise) from refunds rf join payment_intents i3 on i3.id = rf.intent_id
                          join orders o3 on o3.id = i3.order_id where rf.event_id = p_event and o3.kind = o.kind), 0) as c,
               coalesce(sum(i.amount_paise) filter (where i.status in ('pending','requires_review')), 0) as pnd,
               count(*) filter (where i.status in ('paid','partially_refunded','refunded')) as n
          from payment_intents i join orders o on o.id = i.order_id
         where i.event_id = p_event group by o.kind) q), '[]'),
    'by_method', coalesce((select jsonb_agg(jsonb_build_object('method', method, 'count', n, 'amount_paise', amt) order by amt desc) from (
        select method, count(*) n, sum(amount_paise) amt from payment_transactions
         where event_id = p_event and status = 'verified' group by method) q), '[]'),
    -- hourly buckets in the event's local time
    'timeline', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'amount_paise', amt, 'count', n) order by h) from (
        select to_char(date_trunc('hour', pt.created_at at time zone v_tz), 'YYYY-MM-DD"T"HH24:00') h,
               sum(pt.amount_paise) amt, count(*) n
          from payment_transactions pt where pt.event_id = p_event and pt.status = 'verified' group by 1) q), '[]'),
    -- collected value per sellable item: whole package orders, and add-on lines of paid orders
    'top_items', coalesce((select jsonb_agg(x order by (x->>'amount_paise')::bigint desc) from (
        select jsonb_build_object('kind', 'package', 'name', pk.name, 'count', count(*), 'amount_paise', sum(o.total_paise)) x
          from orders o join payment_intents i on i.order_id = o.id join registrations r on r.id = o.registration_id
          join packages pk on pk.id = r.package_id
         where o.event_id = p_event and o.kind = 'package' and i.status in ('paid','partially_refunded') group by pk.name
        union all
        select jsonb_build_object('kind', 'addon', 'name', oi.test_name, 'count', sum(oi.quantity),
                                  'amount_paise', sum((oi.unit_price_paise + oi.tax_paise) * oi.quantity))
          from order_items oi join orders o on o.id = oi.order_id join payment_intents i on i.order_id = o.id
         where oi.event_id = p_event and oi.source = 'addon' and oi.status = 'active'
           and i.status in ('paid','partially_refunded') group by oi.test_name) q), '[]'),
    'by_cashier', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'count', n, 'amount_paise', amt) order by amt desc) from (
        select coalesce(sp.full_name, 'unknown') name, count(*) n, sum(pt.amount_paise) amt from payment_transactions pt
          left join staff_profiles sp on sp.user_id = pt.verified_by
         where pt.event_id = p_event and pt.status = 'verified' group by 1) q), '[]'),
    'registrations', (select count(*) from registrations where event_id = p_event and status = 'active'));
end $$;

revoke execute on function public.package_task_payment(), public.revenue_insights(uuid) from public, anon, authenticated;
grant execute on function public.revenue_insights(uuid) to authenticated;
