'use server';
import { redirect } from 'next/navigation';
import { getEventContext } from '@/lib/auth';
import { bool, orBack, str } from '@/lib/flash';

export async function createAddonOrder(fd: FormData) {
  const eventId = str(fd, 'event_id');
  const ctx = await getEventContext(eventId);
  const reg = str(fd, 'reg'); const desk = str(fd, 'desk');
  const back = `/e/${eventId}/addons?at=${desk}&reg=${reg}`;
  const res = await orBack<{ order_id: string; total_paise: number }>(back, ctx.supabase.rpc('create_addon_order', {
    p_reg: reg, p_desk: desk, p_test_ids: fd.getAll('test_ids').map(String), p_idempotency_key: str(fd, 'idem'), p_consent: bool(fd, 'consent'),
  }));
  redirect(`${back}&order=${res.order_id}&ok=${encodeURIComponent('Add-on order created — payment pending verification')}`);
}
