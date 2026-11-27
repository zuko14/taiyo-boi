import { Children, isValidElement, type ReactNode } from 'react';
import { SubmitButton } from './SubmitButton';

/** Admin config form: hidden context + a mandatory reason when the event is live/paused. */
export function AdminForm({ action, eventId, back, live, children, className, style, hidden }:
  { action: (fd: FormData) => Promise<void>; eventId: string; back: string; live: boolean; children: ReactNode;
    className?: string; style?: React.CSSProperties; hidden?: Record<string, string | null | undefined> }) {
  const reason = live ? <input key="live-reason" className="input" name="reason" required placeholder="Reason for changing live configuration" aria-label="Change reason" style={{ margin: '4px 0 12px' }} /> : null;
  const items = Children.toArray(children);
  const last = items[items.length - 1];
  // the reason is asked before the save button, not after it
  const body = reason && isValidElement(last) && last.type === SubmitButton ? [...items.slice(0, -1), reason, last] : [...items, reason];
  return (
    <form action={action} className={className} style={style}>
      <input type="hidden" name="event_id" value={eventId} />
      <input type="hidden" name="back" value={back} />
      {Object.entries(hidden ?? {}).map(([k, v]) => (v == null ? null : <input key={k} type="hidden" name={k} value={v} />))}
      {body}
    </form>
  );
}

export const isLive = (status: string) => status === 'live' || status === 'paused';
