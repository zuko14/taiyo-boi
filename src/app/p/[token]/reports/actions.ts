'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { smsAdapter } from '@/lib/adapters/sms';
import { env } from '@/lib/env';
import { friendlyError } from '@/lib/errors';
import { str } from '@/lib/flash';
import { rateLimited } from '@/lib/ratelimit';
import { serviceClient } from '@/lib/supabase/server';
import { hmac, newToken, otpCode, sha256 } from '@/lib/tokens';

const valid = (t: string) => /^[A-Za-z0-9_-]{43}$/.test(t);
const otpHash = (tokenHash: string, code: string) => hmac(env().OTP_HMAC_SECRET, `${tokenHash}:${code}`);

export async function requestOtp(fd: FormData) {
  const token = str(fd, 'token');
  const back = `/p/${token}/reports`;
  if (!valid(token) || (await rateLimited('otp-req', 5))) redirect(`${back}?err=${encodeURIComponent('Please wait and try again.')}`);
  const tokenHash = sha256(token);
  const code = otpCode();
  const { data: mobile, error } = await serviceClient().rpc('portal_otp_request', { p_token_hash: tokenHash, p_code_hash: otpHash(tokenHash, code) });
  if (error) redirect(`${back}?err=${encodeURIComponent(friendlyError(error))}`);
  try { await smsAdapter().sendOtp(String(mobile), code); } catch (e) { redirect(`${back}?err=${encodeURIComponent((e as Error).message)}`); }
  redirect(`${back}?sent=1`);
}

export async function verifyOtp(fd: FormData) {
  const token = str(fd, 'token');
  const back = `/p/${token}/reports`;
  if (!valid(token) || (await rateLimited('otp-verify', 10))) redirect(`${back}?err=${encodeURIComponent('Please wait and try again.')}`);
  const tokenHash = sha256(token);
  const session = newToken();
  const { data: ok } = await serviceClient().rpc('portal_otp_verify', {
    p_token_hash: tokenHash, p_code_hash: otpHash(tokenHash, str(fd, 'code')), p_session_hash: sha256(session) });
  if (!ok) redirect(`${back}?sent=1&err=${encodeURIComponent('That code is not valid or has expired.')}`);
  (await cookies()).set('portal_s', session, { httpOnly: true, secure: env().APP_ENV !== 'development', sameSite: 'strict', path: `/p/${token}`, maxAge: 30 * 60 });
  redirect(back);
}
