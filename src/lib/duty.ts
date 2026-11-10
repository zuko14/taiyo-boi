import 'server-only';
import type { EventContext } from '@/lib/auth';

export interface DutyStation { id: string; code: string; name: string; kind: string; status: string; location: string }

/** Stations of the given kinds where the user has an active shift now (all, with shift.override). */
export async function myStations(ctx: EventContext, kinds: string[]): Promise<{ stations: DutyStation[]; override: boolean }> {
  const override = ctx.can('shift.override');
  const { data: all } = await ctx.supabase.from('stations').select('id, code, name, kind, status, location')
    .eq('event_id', ctx.event.id).in('kind', kinds).order('code');
  if (override) return { stations: (all ?? []) as DutyStation[], override };
  const now = new Date().toISOString();
  const { data: shifts } = await ctx.supabase.from('staff_assignments').select('station_id')
    .eq('event_id', ctx.event.id).eq('user_id', ctx.user.id).eq('status', 'active').lte('shift_start', now).gte('shift_end', now);
  const ids = new Set((shifts ?? []).map((s) => s.station_id));
  return { stations: ((all ?? []) as DutyStation[]).filter((s) => ids.has(s.id)), override };
}
