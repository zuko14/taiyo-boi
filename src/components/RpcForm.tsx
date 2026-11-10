import type { ReactNode } from 'react';
import { runRpc } from '@/app/e/[eventId]/rpc-action';

/** Form that calls an allowlisted RPC. Fields named p_* become RPC parameters. */
export function RpcForm({ eventId, rpc, back, next, ok, hidden, children, className, style }:
  { eventId: string; rpc: string; back: string; next?: string; ok?: string; hidden?: Record<string, string | null | undefined>;
    children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <form action={runRpc} className={className} style={style}>
      <input type="hidden" name="event_id" value={eventId} />
      <input type="hidden" name="rpc" value={rpc} />
      <input type="hidden" name="back" value={back} />
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {ok ? <input type="hidden" name="ok_msg" value={ok} /> : null}
      {Object.entries(hidden ?? {}).map(([k, v]) => (v == null ? null : <input key={k} type="hidden" name={k} value={v} />))}
      {children}
    </form>
  );
}

/** Inline action requiring a reason (skip, cancel, pause, withdraw…). */
export function ReasonAction({ eventId, rpc, back, hidden, label, placeholder = 'Reason (required)', danger, ok }:
  { eventId: string; rpc: string; back: string; hidden: Record<string, string | null | undefined>; label: string; placeholder?: string; danger?: boolean; ok?: string }) {
  return (
    <RpcForm eventId={eventId} rpc={rpc} back={back} hidden={hidden} ok={ok} className="row" style={{ flexWrap: 'nowrap' }}>
      <input className="input" name="p_reason" required placeholder={placeholder} aria-label={`${label} reason`} style={{ padding: '7px 12px', minWidth: 140 }} />
      <button className={`btn btn-sm ${danger ? 'btn-red' : 'btn-ghost'}`}>{label}</button>
    </RpcForm>
  );
}
