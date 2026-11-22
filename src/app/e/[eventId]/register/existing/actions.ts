'use server';
import { redirect } from 'next/navigation';
import { getEventContext } from '@/lib/auth';
import { go, orBack, str, strOrNull, bool } from '@/lib/flash';
import { toPct } from '@/lib/format';

/** Tests for an already-registered patient (e.g. advised by the doctor), optionally linked to that consultation. */
export async function addTestsForPatient(fd: FormData) {
  const eventId = str(fd, 'event_id');
  const ctx = await getEventContext(eventId);
  const reg = str(fd, 'reg');
  const back = `/e/${eventId}/register/existing?at=${str(fd, 'counter')}&reg=${reg}`;
  const tests = [...new Set(fd.getAll('test_ids').map(String).filter(Boolean))];
  if (!tests.length) go(back, 'err', 'Select at least one test.');
  const discounts: Record<string, number> = {};
  try { for (const id of tests) { const p = toPct(str(fd, `disc_${id}`)); if (p > 0) discounts[id] = p; } } catch (e) { go(back, 'err', (e as Error).message); }
  await orBack(back, ctx.supabase.rpc('create_addon_order', {
    p_reg: reg, p_desk: str(fd, 'counter'), p_test_ids: tests, p_idempotency_key: str(fd, 'idem'), p_consent: bool(fd, 'consent'),
    p_discounts: Object.keys(discounts).length ? discounts : null, p_discount_reason: strOrNull(fd, 'discount_reason'),
    p_consultation: strOrNull(fd, 'consultation_id'),
    p_referred_doctor: strOrNull(fd, 'referred_doctor'), p_referred_name: strOrNull(fd, 'referred_name'),
  }));
  // the tag screen shows the payment due and the next station, as after a first registration
  redirect(`/e/${eventId}/participants/${reg}/tag?ok=${encodeURIComponent(`${tests.length} test(s) added`)}`);
}
