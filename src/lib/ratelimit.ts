import 'server-only';
import { headers } from 'next/headers';

// shortcut: in-memory fixed window per instance; move to a shared store (e.g. Postgres/Redis) if Render runs >1 instance.
const hits = new Map<string, { n: number; reset: number }>();

export async function rateLimited(bucket: string, limit: number, windowMs = 60_000): Promise<boolean> {
  const h = await headers();
  const ip = (h.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const cur = hits.get(key);
  if (!cur || cur.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return false; }
  cur.n += 1;
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  return cur.n > limit;
}
