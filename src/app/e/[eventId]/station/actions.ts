'use server';
import { getEventContext } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { go, str } from '@/lib/flash';
import { resolveScan } from '@/lib/scan';

const UUID = /^[0-9a-f-]{36}$/;

/**
 * Station scan / pick: the participant is standing at this station, so their service starts at once.
 * - assigned here (waiting or called)            -> start
 * - waiting at another station with this service -> take over here, then start
 * - anything else (other service, done, not found) -> show the participant and why on the page
 * Every step is re-checked by the database (duty, permission, state, compatibility).
 */
export async function scanStart(fd: FormData) {
  const eventId = str(fd, 'event_id');
  const station = str(fd, 'station');
  if (!UUID.test(eventId) || !UUID.test(station)) go(`/e/${eventId}/station`, 'err', 'Choose your station first.');
  const ctx = await getEventContext(eventId);
  const back = `/e/${eventId}/station?at=${station}`;
  const picked = str(fd, 'reg');
  const scan = str(fd, 'scan');
  const reg = UUID.test(picked) ? picked : await resolveScan(ctx, scan, station);
  if (!reg) go(`${back}&find=${encodeURIComponent(scan.slice(0, 80))}`);   // not an exact code/tag: list name matches
  const show = `${back}&reg=${reg}`;

  const { data: qa } = await ctx.supabase.from('queue_assignments')
    .select('task_id, station_id, state, participant_tasks(service_id, service_name), registrations(registration_code, participants(full_name))')
    .eq('registration_id', reg).in('state', ['queued', 'called', 'in_service']).maybeSingle();
  if (!qa) go(show);
  const t = qa.participant_tasks as unknown as { service_id: string; service_name: string };
  const r = qa.registrations as unknown as { registration_code: string; participants: { full_name: string } };
  const who = `${r.participants.full_name} (${r.registration_code}) — ${t.service_name}`;
  if (qa.state === 'in_service') go(show, qa.station_id === station ? 'ok' : undefined, `Already in service: ${who}`);

  if (qa.station_id !== station) {
    const { data: cap } = await ctx.supabase.from('station_capabilities').select('service_id').eq('station_id', station).eq('service_id', t.service_id).maybeSingle();
    if (!cap) go(show);                                                     // their next step is another service
    const { error } = await ctx.supabase.rpc('claim_task', { p_task: qa.task_id, p_station: station });
    if (error) go(show, 'err', friendlyError(error));
  }
  const { error } = await ctx.supabase.rpc('task_action', { p_task: qa.task_id, p_action: 'start', p_station: station });
  if (error) go(show, 'err', friendlyError(error));
  go(back, 'ok', `Started: ${who}. Press Complete when done.`);
}
