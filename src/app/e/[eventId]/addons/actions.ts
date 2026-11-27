'use server';
import { redirect } from 'next/navigation';
import { getEventContext } from '@/lib/auth';
import { bool, go, orBack, str, strOrNull } from '@/lib/flash';
import { toPct } from '@/lib/format';

export async function createAddonOrder(fd: FormData) {
  const eventId = str(fd, 'event_id');
  const ctx = await getEventContext(eventId);
  const reg = str(fd, 'reg'); const desk = str(fd, 'desk');
  const back = `/e/${eventId}/addons?at=${desk}&reg=${reg}`;
  const tests = fd.getAll('test_ids').map(String);
  // per-patient discount (disc_<testId> %); the database re-checks permission, range and reason
  const discounts: Record<string, number> = {};
  try { for (const id of tests) { const p = toPct(str(fd, `disc_${id}`)); if (p > 0) discounts[id] = p; } } catch (e) { go(back, 'err', (e as Error).message); }
  const res = await orBack<{ order_id: string; total_paise: number }>(back, ctx.supabase.rpc('create_addon_order', {
    p_reg: reg, p_desk: desk, p_test_ids: tests, p_idempotency_key: str(fd, 'idem'), p_consent: bool(fd, 'consent'),
    p_discounts: Object.keys(discounts).length ? discounts : null, p_discount_reason: strOrNull(fd, 'discount_reason'),
  }));
  redirect(`${back}&order=${res.order_id}&ok=${encodeURIComponent(res.total_paise > 0 ? 'Add-on order created — payment pending verification' : 'Add-on order created — queued, nothing to pay')}`);
}
