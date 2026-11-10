'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';

/**
 * Realtime messages are only change notifications: on any change we re-render from the
 * server (the database is authoritative). Falls back to polling and shows connection state.
 */
export function LiveRefresh({ eventId, tables, url, anonKey, pollMs = 15000 }:
  { eventId?: string; tables?: string[]; url?: string; anonKey?: string; pollMs?: number }) {
  const router = useRouter();
  const [state, setState] = useState<'live' | 'poll' | 'off'>(tables?.length ? 'poll' : 'poll');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const refresh = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), 400);
    };
    const poll = setInterval(() => { if (navigator.onLine) router.refresh(); }, pollMs);
    const onNet = () => setState(navigator.onLine ? 'poll' : 'off');
    window.addEventListener('online', onNet); window.addEventListener('offline', onNet);

    let cleanup = () => {};
    if (eventId && tables?.length && url && anonKey) {
      const sb = createBrowserClient(url, anonKey);
      const ch = sb.channel(`ev-${eventId}-${tables.join('-')}`);
      for (const t of tables) ch.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: `event_id=eq.${eventId}` }, refresh);
      ch.subscribe((s) => setState(s === 'SUBSCRIBED' ? 'live' : navigator.onLine ? 'poll' : 'off'));
      cleanup = () => { sb.removeChannel(ch); };
    }
    return () => { clearInterval(poll); window.removeEventListener('online', onNet); window.removeEventListener('offline', onNet); cleanup(); };
  }, [eventId, tables, url, anonKey, pollMs, router]);

  const label = state === 'live' ? 'Live' : state === 'poll' ? `Auto-refresh ${Math.round(pollMs / 1000)}s` : 'Offline — changes may not be saved';
  return <span className={`live ${state === 'live' ? '' : state}`} role="status"><span className="dot" />{label}</span>;
}
