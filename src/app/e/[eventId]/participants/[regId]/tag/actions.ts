'use server';
import { getEventContext } from '@/lib/auth';
import { code128Svg, qrSvg } from '@/lib/barcodes';
import { env } from '@/lib/env';
import { friendlyError } from '@/lib/errors';
import { str } from '@/lib/flash';
import { createClient } from '@/lib/supabase/server';
import { newToken, sha256 } from '@/lib/tokens';

export interface TagResult { error?: string; qr?: string; bar?: string; version?: number }

/** Issues a new tag token (revoking any previous one) and returns the label graphics once. */
export async function issueTag(_: TagResult, fd: FormData): Promise<TagResult> {
  const eventId = str(fd, 'event_id');
  const regId = str(fd, 'reg_id');
  const reason = str(fd, 'reason') || null;
  await getEventContext(eventId);
  const supabase = await createClient(reason);
  const token = newToken();                    // plaintext exists only in this response's QR
  const { data, error } = await supabase.rpc('issue_tag', { p_reg: regId, p_token_hash: sha256(token), p_reason: reason });
  if (error) return { error: friendlyError(error) };
  const { data: reg } = await supabase.from('registrations').select('registration_code').eq('id', regId).single();
  return { qr: qrSvg(`${env().APP_URL}/p/${token}`), bar: code128Svg(reg!.registration_code), version: (data as { tag_version: number }).tag_version };
}
