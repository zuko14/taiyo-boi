import { NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Render health check: app up + database reachable. Returns no data.
export async function GET() {
  const t = Date.now();
  const { error } = await serviceClient().from('events').select('id', { head: true, count: 'exact' }).limit(1);
  // app deployed without its database migrations: the queue engine functions are missing
  const probe = error ? null : await serviceClient().rpc('service_coverage', { p_event: '00000000-0000-0000-0000-000000000000' });
  const schema = !probe ? 'unknown' : probe.error?.code === 'PGRST202' ? 'outdated — apply supabase/migrations' : 'ok';
  return NextResponse.json({ ok: !error, db: error ? 'unreachable' : 'ok', schema, ms: Date.now() - t }, { status: error ? 503 : 200 });
}
