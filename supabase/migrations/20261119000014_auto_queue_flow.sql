-- Fully automatic queue flow. Staff never need "Call next":
--   1. Auto-call: whenever a station has a free service slot (slots = staff on shift, capped by
--      capacity), the next participant in its queue is called automatically (portal: "go now").
--   2. Auto-move: a free station with an empty queue takes the longest-waiting participant from a
--      compatible station whose slots are all busy (fairness: nobody waits behind a busy station
--      while an equivalent one is idle). Participants already called or in service never move.
--   3. Both run after every scheduling decision (registration, payment, completion, no-show, station
--      open/close, shift change, page refresh nudge), inside the event lock, so they are serialised
--      with every other queue write.
-- Assignment itself is unchanged: lowest estimated wait among compatible open staffed stations.

create or replace function public._station_slots(p_station uuid) returns int
language sql stable security definer set search_path = public as $$
  select case when count(distinct a.user_id) = 0 then 0 else least(s.capacity, count(distinct a.user_id))::int end
    from stations s left join staff_assignments a on a.station_id = s.id and a.status = 'active'
         and now() between a.shift_start and a.shift_end
   where s.id = p_station group by s.capacity
$$;

create or replace function public._station_busy(p_station uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from queue_assignments where station_id = p_station and state in ('called','in_service')
$$;

-- Fill every free slot of every open, staffed diagnostic station of the event. Returns calls made.
create or replace function public._autoflow(p_event uuid) returns int
language plpgsql security definer set search_path = public as $$
declare st record; q record; v_seq int; v_new uuid; n int := 0; v_free int;
begin
  if (select status from events where id = p_event) <> 'live' then return 0; end if;
  perform public._lock_event(p_event);
  for st in
    select s.* from stations s
     where s.event_id = p_event and s.kind = 'station' and s.status = 'open' and s.accepts_assignments
     order by s.last_assigned_at nulls first, s.code
     for update
  loop
    v_free := public._station_slots(st.id) - public._station_busy(st.id);
    while v_free > 0 loop
      -- 1. next in this station's own queue
      select qa.* into q from queue_assignments qa
       where qa.station_id = st.id and qa.state = 'queued' order by qa.seq limit 1 for update;
      if q.id is null then
        -- 2. longest-waiting participant queued behind a compatible station whose slots are all busy
        select qa.* into q from queue_assignments qa
          join participant_tasks t on t.id = qa.task_id
          join stations o on o.id = qa.station_id
         where qa.event_id = p_event and qa.state = 'queued' and qa.station_id <> st.id
           and exists (select 1 from station_capabilities c where c.station_id = st.id and c.service_id = t.service_id)
           -- that station cannot serve them now: all slots busy, no staff on shift, or not open
           and (o.status <> 'open' or not o.accepts_assignments
                or public._station_busy(o.id) >= public._station_slots(o.id))
         order by qa.assigned_at, qa.seq limit 1
         for update of qa;
        exit when q.id is null;
        update queue_assignments set state = 'reassigned', ended_at = now() where id = q.id;
        update stations set next_seq = next_seq + 1, last_assigned_at = clock_timestamp()
         where id = st.id returning next_seq - 1 into v_seq;
        insert into queue_assignments (event_id, task_id, registration_id, station_id, seq, reason, score)
        values (p_event, q.task_id, q.registration_id, st.id, v_seq,
                format('Automatically moved from %s: %s was free while %s could not serve yet',
                       (select code from stations where id = q.station_id), st.code, (select code from stations where id = q.station_id)),
                jsonb_build_object('policy', 'auto_move_to_idle_station', 'from_station', q.station_id))
        returning id into v_new;                       -- guard trigger re-checks compatibility
        update participant_tasks set station_id = st.id where id = q.task_id;
        perform public.write_audit(p_event, 'queue.auto_move', 'participant_task', q.task_id::text, null,
          jsonb_build_object('from_station', q.station_id, 'to_station', st.id));
        select * into q from queue_assignments where id = v_new;
      end if;
      update queue_assignments set state = 'called', called_at = now() where id = q.id;
      perform public._set_task_status(q.task_id, 'called', 'Called automatically — ' || st.name || ' is free', 'scheduler', st.id);
      n := n + 1;
      v_free := v_free - 1;
    end loop;
  end loop;
  return n;
end $$;

-- every scheduling decision ends with the automatic flow
alter function public._schedule_next(uuid) rename to _schedule_one;
create function public._schedule_next(p_reg uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid; v_event uuid := (select event_id from registrations where id = p_reg);
begin
  v := public._schedule_one(p_reg);
  if v_event is not null then perform public._autoflow(v_event); end if;
  return v;
end $$;

do $do$
declare d text;
begin
  -- opening a station / assigning staff with nobody waiting must still start calling its queue
  d := pg_get_functiondef('public._rebalance_waiting(uuid)'::regprocedure);
  d := replace(d, $old$  end loop;
  return n;$old$, $new$  end loop;
  perform public._autoflow(p_event);
  return n;$new$);
  if position('_autoflow' in d) = 0 then raise exception '_rebalance_waiting patch did not apply'; end if;
  execute d;

  -- the refresh nudge also wakes a station that has a free slot and someone to call or take over
  d := pg_get_functiondef('public.nudge_waiting(uuid)'::regprocedure);
  d := replace(d, $old$                                     and q.state in ('queued','called')) < s.max_queue)) then
    return 0;
  end if;$old$, $new$                                     and q.state in ('queued','called')) < s.max_queue))
     and not exists (
    select 1 from stations s
     where s.event_id = p_event and s.kind = 'station' and s.status = 'open' and s.accepts_assignments
       and public._station_busy(s.id) < public._station_slots(s.id)
       and exists (select 1 from queue_assignments qa join participant_tasks t on t.id = qa.task_id
                    where qa.event_id = p_event and qa.state = 'queued'
                      and (qa.station_id = s.id or exists (select 1 from station_capabilities c
                                                            where c.station_id = s.id and c.service_id = t.service_id)))) then
    return 0;
  end if;$new$);
  if position('_station_slots' in d) = 0 then raise exception 'nudge_waiting patch did not apply'; end if;
  execute d;

  -- an auto-called participant must not be left at a station whose last shift just ended
  d := pg_get_functiondef('public.end_staff_assignment(uuid,text)'::regprocedure);
  d := replace(d, $old$where station_id = a.station_id and state = 'queued' order by seq loop$old$,
                  $new$where station_id = a.station_id and state in ('queued','called') order by seq loop$new$);
  if position($x$state in ('queued','called') order by seq loop$x$ in d) = 0 then raise exception 'end_staff_assignment patch did not apply'; end if;
  execute d;
end $do$;

revoke execute on function public._station_slots(uuid), public._station_busy(uuid), public._autoflow(uuid),
  public._schedule_one(uuid), public._schedule_next(uuid) from public, anon, authenticated;
