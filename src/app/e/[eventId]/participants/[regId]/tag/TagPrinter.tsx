'use client';
import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { TagLabel, type TagInfo } from '@/components/TagLabel';
import { issueTag, type TagResult } from './actions';

export function TagPrinter({ eventId, regId, info, isReprint }: { eventId: string; regId: string; info: TagInfo; isReprint: boolean }) {
  const [state, action, pending] = useActionState<TagResult, FormData>(issueTag, {});
  const router = useRouter();
  // print, then refresh server data so the 'confirm printed' step appears (label stays in client state)
  useEffect(() => { if (state.qr) { setTimeout(() => window.print(), 300); router.refresh(); } }, [state.qr, router]);
  return (
    <div>
      {state.error ? <div className="alert alert-err no-print" role="alert">{state.error}</div> : null}
      {!state.qr ? (
        <form action={action} className="no-print">
          <input type="hidden" name="event_id" value={eventId} /><input type="hidden" name="reg_id" value={regId} />
          {isReprint ? (
            <div className="field"><label htmlFor="reason">Reprint reason (the previous tag&apos;s QR will stop working)</label>
              <input id="reason" name="reason" required placeholder="e.g. printer jam, damaged label" /></div>
          ) : null}
          <button className="btn btn-accent btn-lg" disabled={pending}>{pending ? 'Preparing…' : isReprint ? 'Reprint tag' : 'Print tag'}</button>
        </form>
      ) : (
        <>
          <div className="row no-print" style={{ marginBottom: 14 }}>
            <button className="btn btn-ghost" onClick={() => window.print()}>Print again (same tag v{state.version})</button>
          </div>
          <div style={{ background: '#fff', padding: 12, display: 'inline-block', borderRadius: 8 }}>
            <TagLabel info={info} qr={state.qr} bar={state.bar!} />
          </div>
        </>
      )}
    </div>
  );
}
