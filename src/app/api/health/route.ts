import { NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Render health check: app up + database reachable. Returns no data.
export async function GET() {
  const t = Date.now();
  const { error } = await serviceClient().from('events').select('id', { head: true, count: 'exact' }).limit(1);
  return NextResponse.json({ ok: !error, db: error ? 'unreachable' : 'ok', ms: Date.now() - t }, { status: error ? 503 : 200 });
}
