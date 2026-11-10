import { NextResponse } from 'next/server';
import { getEventContext } from '@/lib/auth';
import { serviceClient } from '@/lib/supabase/server';

// Staff view of a report file: RLS decides visibility (report.view); a 60-second signed URL is issued.
export async function GET(_: Request, { params }: { params: Promise<{ eventId: string; reportId: string }> }) {
  const { eventId, reportId } = await params;
  const ctx = await getEventContext(eventId);
  const { data: rp } = await ctx.supabase.from('reports').select('id, storage_key, event_id').eq('id', reportId).eq('event_id', eventId).maybeSingle();
  if (!rp) return new NextResponse('Not found', { status: 404 });
  const svc = serviceClient();
  const { data, error } = await svc.storage.from('reports').createSignedUrl(rp.storage_key, 60);
  if (error || !data) return new NextResponse('File unavailable', { status: 404 });
  await svc.from('audit_logs').insert({ event_id: eventId, actor_id: ctx.user.id, action: 'report.staff_view', entity_type: 'report', entity_id: reportId });
  return NextResponse.redirect(data.signedUrl, { headers: { 'Cache-Control': 'private, no-store' } });
}
