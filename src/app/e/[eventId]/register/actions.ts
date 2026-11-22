'use server';
import { redirect } from 'next/navigation';
import { getEventContext } from '@/lib/auth';
import { bool, go, intOrNull, orBack, str, strOrNull } from '@/lib/flash';
import { toPct } from '@/lib/format';

export async function registerParticipant(fd: FormData) {
  const eventId = str(fd, 'event_id');
  const ctx = await getEventContext(eventId);
  const back = `/e/${eventId}/register?at=${str(fd, 'counter')}`;
  const tests = fd.getAll('test_ids').map(String).filter(Boolean);
  // per-patient desk discounts: disc_<testId> for selected tests, package_discount_pct; the database re-checks everything
  const discounts: Record<string, number> = {};
  let pkgPct = 0;
  try {
    for (const id of tests) { const p = toPct(str(fd, `disc_${id}`)); if (p > 0) discounts[id] = p; }
    pkgPct = toPct(str(fd, 'package_discount_pct'));
  } catch (e) { go(back, 'err', (e as Error).message); }
  const res = await orBack<{ registration_id: string; registration_code: string; already: boolean }>(back,
    ctx.supabase.rpc('register_participant', {
      p_counter: str(fd, 'counter'), p_idempotency_key: str(fd, 'idem'), p_classification: str(fd, 'classification'),
      p_full_name: str(fd, 'full_name'), p_age: intOrNull(fd, 'age'), p_employee_id: strOrNull(fd, 'employee_id'),
      p_mobile: strOrNull(fd, 'mobile'), p_email: strOrNull(fd, 'email'), p_department: strOrNull(fd, 'department'),
      p_consent: bool(fd, 'consent'), p_package_override: strOrNull(fd, 'package_override'),
      p_override_reason: strOrNull(fd, 'override_reason'),
      p_test_ids: tests.length ? tests : null,
      p_discounts: Object.keys(discounts).length ? discounts : null,
      p_package_discount_pct: pkgPct || null,
      p_discount_reason: strOrNull(fd, 'discount_reason'),
      p_doctor: strOrNull(fd, 'doctor_id'),
      p_referred_doctor: strOrNull(fd, 'referred_doctor'), p_referred_name: strOrNull(fd, 'referred_name'),
    }));
  const msg = res.already ? `Already registered (retry detected): ${res.registration_code}` : `Registered ${res.registration_code}`;
  redirect(`/e/${eventId}/participants/${res.registration_id}/tag?ok=${encodeURIComponent(msg)}`);
}
