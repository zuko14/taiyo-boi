import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type Fixture, must, serviceClient } from '../../scripts/lib/fixture.ts';

export { must };
export const db = () => serviceClient();
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newCode = (p: string) => `${p}-${randomUUID().slice(0, 6).toUpperCase()}`;

export async function register(fx: Fixture, classification: 'female' | 'male', extra: Record<string, unknown> = {}) {
  const res = await must<{ registration_id: string; registration_code: string; already: boolean }>(
    fx.users.registration_staff.client.rpc('register_participant', {
      p_counter: fx.stations['REG-1'], p_idempotency_key: randomUUID(), p_classification: classification,
      p_full_name: `Synthetic ${randomUUID().slice(0, 5)}`, p_age: 40, p_consent: true, ...extra,
    }));
  return res;
}

export async function tasksOf(regId: string) {
  return must<{ id: string; service_name: string; location: string; status: string; station_id: string | null;
    source: string; choice_group_id: string | null; payment_intent_id: string | null }[]>(
    db().from('participant_tasks').select('*').eq('registration_id', regId).order('created_at'));
}

export async function activeAssignment(regId: string) {
  const rows = await must<{ id: string; task_id: string; station_id: string; state: string; seq: number }[]>(
    db().from('queue_assignments').select('*').eq('registration_id', regId).in('state', ['queued', 'called', 'in_service']));
  return rows[0];
}

export async function rpcError(p: PromiseLike<{ error: { message: string } | null }>): Promise<string> {
  const { error } = await p;
  if (!error) throw new Error('expected an error');
  return error.message;
}

/** Start + complete the participant's current assignment as station staff. */
export async function completeCurrent(fx: Fixture, regId: string, staff: SupabaseClient = fx.users.station_staff.client) {
  const a = await activeAssignment(regId);
  if (!a) return null;
  await must(staff.rpc('task_action', { p_task: a.task_id, p_action: 'start', p_station: a.station_id, p_reason: null }));
  await must(staff.rpc('task_action', { p_task: a.task_id, p_action: 'complete', p_station: a.station_id, p_reason: null }));
  return a;
}
