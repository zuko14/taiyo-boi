import 'server-only';
import type { EventContext } from '@/lib/auth';
import { parseScan } from '@/lib/tokens';

/** Resolve a scanned value to a registration id (server-side, staff session required, scan audited). */
export async function resolveScan(ctx: EventContext, raw: string | undefined, stationId?: string) {
  if (!raw?.trim()) return null;
  const s = parseScan(raw);
  const { data } = await ctx.supabase.rpc('resolve_scan', { p_event: ctx.event.id, p_code: s.code, p_token_hash: s.tokenHash, p_station: stationId ?? null });
  return (data as string | null) ?? null;
}

export interface ScanMatch { id: string; registration_code: string; full_name: string; classification: string; status: string }

/** When a scan is not an exact code/tag, list candidates by name, code, employee ID or mobile. Never auto-picks. */
export async function searchRegistrations(ctx: EventContext, raw: string | undefined): Promise<ScanMatch[]> {
  const q = (raw ?? '').trim();
  if (q.length < 2 || parseScan(q).tokenHash) return [];
  const safe = q.replace(/[%,()*]/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
  const { data } = await ctx.supabase.from('registration_overview')
    .select('id, registration_code, full_name, classification, status').eq('event_id', ctx.event.id)
    .or(`registration_code.ilike.%${safe}%,name_search.ilike.%${safe}%,employee_id.ilike.%${safe}%,mobile.ilike.%${safe}%`)
    .order('registration_code').limit(10);
  return (data ?? []) as ScanMatch[];
}
