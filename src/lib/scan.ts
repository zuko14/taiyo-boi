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
