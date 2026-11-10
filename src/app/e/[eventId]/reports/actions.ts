'use server';
import { createHash } from 'node:crypto';
import { getEventContext } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { go, str, strOrNull } from '@/lib/flash';
import { serviceClient } from '@/lib/supabase/server';

const MAX = 15 * 1024 * 1024;

/** Detects the real file type from its first bytes (never trusts the browser's MIME type). */
function sniff(buf: Buffer): string | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

export async function uploadReport(fd: FormData) {
  const eventId = str(fd, 'event_id');
  const back = `/e/${eventId}/reports?tab=upload&reg=${str(fd, 'reg')}`;
  const ctx = await getEventContext(eventId);
  const file = fd.get('file');
  if (!(file instanceof File) || file.size === 0) go(back, 'err', 'Choose a report file.');
  if (file.size > MAX) go(back, 'err', 'File is larger than 15 MB.');
  const buf = Buffer.from(await file.arrayBuffer());
  const mime = sniff(buf);
  if (!mime) go(back, 'err', 'Only PDF, PNG or JPEG files are accepted.');
  const checksum = createHash('sha256').update(buf).digest('hex');

  const { data, error } = await ctx.supabase.rpc('report_create', {
    p_order_item: str(fd, 'order_item'), p_title: str(fd, 'title') || 'Report', p_file_name: file.name.slice(0, 200),
    p_mime: mime, p_size: buf.length, p_checksum: checksum, p_accession: strOrNull(fd, 'accession'),
  });
  if (error) go(back, 'err', friendlyError(error));
  const rp = data as { report_id: string; storage_key: string; status: string };

  // private bucket; written by the server only after the RPC authorised the upload
  const up = await serviceClient().storage.from('reports').upload(rp.storage_key, buf, { contentType: mime, upsert: false });
  if (up.error) {
    await ctx.supabase.rpc('report_action', { p_report: rp.report_id, p_action: 'upload_failed', p_reason: 'storage error' });
    go(back, 'err', 'Upload to storage failed. The report was not published; try again.');
  }
  await ctx.supabase.rpc('report_action', { p_report: rp.report_id, p_action: 'uploaded' });
  go(back, rp.status === 'requires_review' ? 'err' : 'ok',
    rp.status === 'requires_review' ? 'Uploaded but held for review: the reference does not match this test.' : 'Uploaded — waiting for validation by a different person.');
}
