'use server';
import { getEventContext } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { go, safePath, str } from '@/lib/flash';
import { localInputToIso, toPaise } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';

// Allowlisted state-change RPCs reachable from <RpcForm>. Each one re-checks permission,
// duty context and state transitions inside the database.
const ALLOWED = new Set([
  'task_action', 'select_choice', 'correct_registration', 'resolve_duplicate', 'migrate_registration_config',
  'revoke_tag', 'grant_payment_exception', 'confirm_tag_printed', 'call_next', 'reassign_task', 'rebalance_waiting',
  'station_set_status', 'assign_staff', 'end_staff_assignment', 'payment_action', 'verify_payment', 'report_action',
  'set_event_status', 'confirm_order_item', 'set_external_accession',
]);

export async function runRpc(fd: FormData) {
  const eventId = str(fd, 'event_id');
  const back = safePath(str(fd, 'back'), `/e/${eventId}`);
  const name = str(fd, 'rpc');
  if (!ALLOWED.has(name)) go(back, 'err', 'Unknown action');
  const ctx = await getEventContext(eventId);

  const params: Record<string, unknown> = {};
  for (const key of new Set(fd.keys())) {
    if (!key.startsWith('p_')) continue;
    const values = fd.getAll(key).map((v) => String(v).trim());
    if (key.endsWith('_ids')) params[key] = values.filter(Boolean);
    else if (key.endsWith('_local')) params[key.slice(0, -6)] = values[0] ? localInputToIso(values[0], ctx.event.timezone) : null;
    else params[key] = values[0] === '' ? null : values[0];
  }
  if (fd.has('amount_rupees')) {
    try { params.p_amount_paise = toPaise(str(fd, 'amount_rupees')); } catch (e) { go(back, 'err', (e as Error).message); }
  }
  const reason = typeof params.p_reason === 'string' ? params.p_reason : null;
  const supabase = reason ? await createClient(reason) : ctx.supabase;
  const { data, error } = await supabase.rpc(name, params);
  if (error) go(back, 'err', friendlyError(error));
  const d = data as { ok?: boolean; empty?: boolean; reason?: string; status?: string; receipt_no?: string; moved?: number } | null;
  if (d?.ok === false) go(back, 'err', `Held for review: ${d.reason?.replace(/_/g, ' ') ?? d.status}`);
  if (d?.empty) go(back, 'ok', 'No one is waiting in this queue.');
  const next = safePath(str(fd, 'next'), back);
  go(next, 'ok', str(fd, 'ok_msg') || (d?.receipt_no ? `Verified · receipt ${d.receipt_no}` : 'Saved'));
}
