-- Record an external LIS/accession reference against a task and its order lines (structured, audited).
create or replace function public.set_external_accession(p_task uuid, p_station uuid, p_accession text)
returns void language plpgsql security definer set search_path = public as $$
declare t participant_tasks;
begin
  select * into t from participant_tasks where id = p_task for update;
  if not found then raise exception 'not_found: task'; end if;
  perform public.require_perm(t.event_id, case t.location when 'walk_in' then 'walkin.perform' else 'task.perform' end);
  perform public.assert_on_duty(p_station, array['station','walkin_centre']);
  if coalesce(btrim(p_accession), '') = '' or length(p_accession) > 80 then raise exception 'invalid_accession'; end if;
  if t.status not in ('checked_in','in_service','completed','called','queued') then
    raise exception 'illegal_transition: record the reference once the participant has arrived';
  end if;
  update participant_tasks set external_accession = btrim(p_accession) where id = t.id;
  update order_items set external_accession = btrim(p_accession)
   where id in (select order_item_id from task_items where task_id = t.id);
  perform public.write_audit(t.event_id, 'task.accession', 'participant_task', t.id::text, null,
    jsonb_build_object('accession', btrim(p_accession), 'previous', t.external_accession));
end $$;

revoke execute on function public.set_external_accession(uuid, uuid, text) from public, anon;
grant execute on function public.set_external_accession(uuid, uuid, text) to authenticated;
