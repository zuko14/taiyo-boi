-- Queue recovery: nobody is left without a next step while the event is live.
-- Bug 1: a participant held as waiting_unassigned (station full / no staff) was only re-checked when
--        someone opened a staff page (nudge). Now every scheduling decision re-checks them at once.
-- Bug 2: a participant whose ticket was cancelled while the event was not live (station closed during a
--        pause) went back to not_ready and was never picked up again, because the re-check only looked
--        at waiting_unassigned tasks. Now it looks at every active registration with an eligible
--        event-day task and no active ticket.

create or replace function public._rebalance_waiting(p_event uuid) returns int
language plpgsql security definer set search_path = public as $$
declare v_reg uuid; n int := 0;
begin
  perform public._lock_event(p_event);
  if (select status from events where id = p_event) = 'live' then
    for v_reg in
      select t.registration_id from participant_tasks t
        join registrations r on r.id = t.registration_id and r.status = 'active'
       where t.event_id = p_event and t.location = 'event_day' and t.status in ('not_ready','waiting_unassigned')
         and not exists (select 1 from queue_assignments q where q.registration_id = t.registration_id
                           and q.state in ('queued','called','in_service'))
         and public._task_eligible(t)
       group by t.registration_id
       order by min(t.waiting_since) nulls last, min(r.created_at)   -- longest waiting first
    loop
      if public._schedule_one(v_reg) is not null then n := n + 1; end if;   -- _schedule_one: no recursion
    end loop;
  end if;
  perform public._autoflow(p_event);
  return n;
end $$;

create or replace function public._schedule_next(p_reg uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid; v_event uuid := (select event_id from registrations where id = p_reg);
begin
  v := public._schedule_one(p_reg);
  -- capacity this decision freed goes to whoever is still waiting; then free slots call the next person
  if v_event is not null then perform public._rebalance_waiting(v_event); end if;
  return v;
end $$;

revoke execute on function public._rebalance_waiting(uuid), public._schedule_next(uuid) from public, anon, authenticated;
