import 'server-only';
import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export interface EventRow {
  id: string; code: string; name: string; status: string; timezone: string; venue: string; help_contact: string;
  lab_partner_name: string; sponsor_name: string; portal_instructions: string; settings: Record<string, unknown>;
  [k: string]: unknown;
}

export const requireStaff = cache(async () => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: profile } = await supabase.from('staff_profiles').select('*').eq('user_id', user.id).maybeSingle();
  if (!profile) redirect('/login?err=' + encodeURIComponent('This account has no staff profile.'));
  return { supabase, user, profile: profile as { user_id: string; full_name: string; email: string; is_platform_admin: boolean } };
});

export const getEventContext = cache(async (eventId: string) => {
  const staff = await requireStaff();
  if (!/^[0-9a-f-]{36}$/.test(eventId)) notFound();
  const { data: event } = await staff.supabase.from('events').select('*').eq('id', eventId).maybeSingle();
  if (!event) notFound();
  const { data: perms } = await staff.supabase.rpc('my_permissions', { p_event: eventId });
  const set = new Set<string>(perms ?? []);
  return { ...staff, event: event as EventRow, perms: set, can: (...p: string[]) => p.some((x) => set.has(x)) };
});

export type EventContext = Awaited<ReturnType<typeof getEventContext>>;

/** Page guard: any of the listed permissions. UI hiding is cosmetic; the database enforces. */
export async function requirePerm(eventId: string, ...perms: string[]) {
  const ctx = await getEventContext(eventId);
  if (!ctx.can(...perms)) redirect(`/e/${eventId}?err=${encodeURIComponent('You do not have access to that area.')}`);
  return ctx;
}
