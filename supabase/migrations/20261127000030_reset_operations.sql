-- Training drills / mock runs: remove only the patient-side data and keep the whole camp set up.
--   reset_event       (existing) : patients + operations, AND clears staff shifts, closes stations, status → Draft.
--   reset_operations  (new)      : patients + operations only. Staff, their station shifts, station open/paused
--                                  status and the event status stay exactly as they are; codes restart at 1.
-- Refused while the event is live (pause it first) so a real camp cannot be wiped by one mistaken click.

drop function public._purge_operational(uuid);
create function public._purge_operational(p_event uuid, p_keep_staff boolean default false) returns text[]
language plpgsql security definer set search_path = public as $$
declare v_keys text[];
begin
  perform set_config('app.purge', 'on', true);
  select coalesce(array_agg(storage_key), '{}') into v_keys from reports where event_id = p_event;
  delete from portal_sessions where registration_id in (select id from registrations where event_id = p_event);
  delete from portal_otps where registration_id in (select id from registrations where event_id = p_event);
  delete from report_import_jobs where event_id = p_event;
  delete from reports where event_id = p_event;
  delete from scan_events where event_id = p_event;
  delete from task_attendance_events where event_id = p_event;
  delete from task_status_history where event_id = p_event;
  delete from queue_assignments where event_id = p_event;
  delete from task_items where task_id in (select id from participant_tasks where event_id = p_event);
  delete from participant_tasks where event_id = p_event;
  delete from walkin_visits where event_id = p_event;
  delete from receipts where event_id = p_event;
  delete from refunds where event_id = p_event;
  delete from payment_transactions where event_id = p_event;
  delete from payment_intents where event_id = p_event;
  delete from order_items where event_id = p_event;
  delete from orders where event_id = p_event;
  delete from tag_prints where registration_id in (select id from registrations where event_id = p_event);
  delete from registration_tokens where registration_id in (select id from registrations where event_id = p_event);
  delete from registrations where event_id = p_event;          -- consultations cascade
  delete from participants where event_id = p_event;
  delete from package_code_counters where event_id = p_event;
  if not p_keep_staff then
    delete from staff_assignments where event_id = p_event;
    delete from station_events where event_id = p_event;
  end if;
  return v_keys;
end $$;

create or replace function public.reset_operations(p_event uuid, p_confirm_code text, p_reason text) returns text[]
language plpgsql security definer set search_path = public as $$
declare e events; v_regs int; v_keys text[];
begin
  perform public._lock_event(p_event);
  if not (public.is_platform_admin() or public.has_perm(p_event, 'event.reset')) then
    raise exception 'permission_denied: event.reset' using errcode = '42501';
  end if;
  select * into e from events where id = p_event for update;
  if e.id is null then raise exception 'not_found: event'; end if;
  if e.status = 'live' then
    raise exception 'event_live: pause the event before clearing patient data, then set it live again for the next drill';
  end if;
  if upper(btrim(coalesce(p_confirm_code, ''))) <> e.code then
    raise exception 'confirm_mismatch: type the event code % to confirm', e.code;
  end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required: reset reason'; end if;
  perform set_config('app.reason', p_reason, true);
  select count(*) into v_regs from registrations where event_id = p_event;
  v_keys := public._purge_operational(p_event, true);
  update stations set next_seq = 1, last_assigned_at = null where event_id = p_event;   -- tickets restart at 1
  update events set receipt_seq = 0 where id = p_event;
  perform public.write_audit(p_event, 'event.reset_operations', 'event', p_event::text, p_reason,
    jsonb_build_object('registrations_removed', v_regs, 'status', e.status, 'report_files', coalesce(array_length(v_keys, 1), 0)));
  return v_keys;
end $$;

revoke execute on function public._purge_operational(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.reset_operations(uuid, text, text) from public, anon;
grant execute on function public.reset_operations(uuid, text, text) to authenticated;
