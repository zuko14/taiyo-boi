-- Computed field for station / walk-in screens: has this task's add-on payment been cleared?
-- Staff there have no payment.view; this exposes only a yes/no for task rows they can already see.
create or replace function public.payment_cleared(t public.participant_tasks) returns boolean
language sql stable security definer set search_path = public as $$
  select t.payment_intent_id is null or t.payment_exception
      or exists (select 1 from payment_intents p where p.id = t.payment_intent_id and p.status in ('paid','waived'))
$$;
revoke execute on function public.payment_cleared(public.participant_tasks) from public, anon;
grant execute on function public.payment_cleared(public.participant_tasks) to authenticated;
