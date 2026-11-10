import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { createClient as createSbClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { connection } from 'next/server';
import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';

/**
 * Staff client bound to the signed-in user's cookies: every query runs under RLS.
 * `reason` is forwarded (base64) to the database audit trigger for live-config edits.
 */
export async function createClient(reason?: string | null) {
  await connection();
  const store = await cookies();
  const headers: Record<string, string> = { 'x-request-id': randomUUID() };
  if (reason?.trim()) headers['x-audit-reason'] = Buffer.from(reason.trim(), 'utf8').toString('base64');
  return createServerClient(env().NEXT_PUBLIC_SUPABASE_URL, env().NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers },
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try { list.forEach(({ name, value, options }) => store.set(name, value, options)); } catch { /* server component: proxy refreshes */ }
      },
    },
  });
}

/**
 * Service-role client. Bypasses RLS: use only after server-side authorisation
 * (participant portal by token, private report storage, staff account creation).
 */
export function serviceClient() {
  return createSbClient(env().NEXT_PUBLIC_SUPABASE_URL, env().SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Fresh idempotency key for a form render; retries of the same submission reuse it. */
export async function idemKey() {
  await connection();
  return randomUUID();
}
