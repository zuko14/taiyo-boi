'use server';
import { redirect } from 'next/navigation';
import { getEventContext } from '@/lib/auth';
import { bool, intOrNull, orBack, str, strOrNull } from '@/lib/flash';

export async function registerParticipant(fd: FormData) {
  const eventId = str(fd, 'event_id');
  const ctx = await getEventContext(eventId);
  const back = `/e/${eventId}/register?at=${str(fd, 'counter')}`;
  const res = await orBack<{ registration_id: string; registration_code: string; already: boolean }>(back,
    ctx.supabase.rpc('register_participant', {
      p_counter: str(fd, 'counter'), p_idempotency_key: str(fd, 'idem'), p_classification: str(fd, 'classification'),
      p_full_name: str(fd, 'full_name'), p_age: intOrNull(fd, 'age'), p_employee_id: strOrNull(fd, 'employee_id'),
      p_mobile: strOrNull(fd, 'mobile'), p_email: strOrNull(fd, 'email'), p_department: strOrNull(fd, 'department'),
      p_consent: bool(fd, 'consent'), p_package_override: strOrNull(fd, 'package_override'),
      p_override_reason: strOrNull(fd, 'override_reason'),
    }));
  const msg = res.already ? `Already registered (retry detected): ${res.registration_code}` : `Registered ${res.registration_code}`;
  redirect(`/e/${eventId}/participants/${res.registration_id}/tag?ok=${encodeURIComponent(msg)}`);
}
