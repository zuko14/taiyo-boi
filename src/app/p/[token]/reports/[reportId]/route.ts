import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabase/server';
import { sha256 } from '@/lib/tokens';

// Verified participant download: the report must be in this participant's published list for
// the current OTP session; then a 60-second signed URL is issued and the download is audited.
export async function GET(_: Request, { params }: { params: Promise<{ token: string; reportId: string }> }) {
  const { token, reportId } = await params;
  const session = (await cookies()).get('portal_s')?.value;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !session) return new NextResponse('Verification required', { status: 401 });
  const svc = serviceClient();
  const tokenHash = sha256(token);
  const { data, error } = await svc.rpc('portal_reports', { p_token_hash: tokenHash, p_session_hash: sha256(session) });
  const rp = (data as { report_id: string; storage_key: string }[] | null)?.find((r) => r.report_id === reportId);
  if (error || !rp) return new NextResponse('Not available', { status: 404 });
  const { data: signed } = await svc.storage.from('reports').createSignedUrl(rp.storage_key, 60);
  if (!signed) return new NextResponse('File unavailable', { status: 404 });
  await svc.rpc('portal_log_download', { p_token_hash: tokenHash, p_report: reportId });
  return NextResponse.redirect(signed.signedUrl, { headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } });
}
