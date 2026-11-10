import type { ReactNode } from 'react';

/** Admin config form: hidden context + a mandatory reason when the event is live/paused. */
export function AdminForm({ action, eventId, back, live, children, className, style, hidden }:
  { action: (fd: FormData) => Promise<void>; eventId: string; back: string; live: boolean; children: ReactNode;
    className?: string; style?: React.CSSProperties; hidden?: Record<string, string | null | undefined> }) {
  return (
    <form action={action} className={className} style={style}>
      <input type="hidden" name="event_id" value={eventId} />
      <input type="hidden" name="back" value={back} />
      {Object.entries(hidden ?? {}).map(([k, v]) => (v == null ? null : <input key={k} type="hidden" name={k} value={v} />))}
      {children}
      {live ? <input className="input" name="reason" required placeholder="Reason for changing live configuration" aria-label="Change reason" style={{ marginTop: 8 }} /> : null}
    </form>
  );
}

export const isLive = (status: string) => status === 'live' || status === 'paused';
