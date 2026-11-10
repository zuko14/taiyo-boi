import 'server-only';
import { redirect } from 'next/navigation';
import { friendlyError } from '@/lib/errors';

export function go(path: string, kind?: 'ok' | 'err', msg?: string): never {
  const u = new URL(path, 'http://local');
  u.searchParams.delete('ok'); u.searchParams.delete('err');
  if (kind && msg) u.searchParams.set(kind, msg.slice(0, 300));
  redirect(u.pathname + u.search);
}

/** Await a Supabase call; on error, return to `path` with a plain-language message. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function orBack<T = any>(path: string, p: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) go(path, 'err', friendlyError(error));
  return data as T;
}

export const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v.trim() : '';
};
export const strOrNull = (fd: FormData, k: string) => str(fd, k) || null;
export const intOrNull = (fd: FormData, k: string) => {
  const v = str(fd, k);
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};
export const bool = (fd: FormData, k: string) => fd.get(k) === 'on' || fd.get(k) === 'true';

/** Only allow same-site relative return paths. */
export const safePath = (p: string, fallback: string) => (p.startsWith('/') && !p.startsWith('//') ? p : fallback);
