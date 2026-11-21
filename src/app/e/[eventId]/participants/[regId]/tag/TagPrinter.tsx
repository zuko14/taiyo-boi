'use client';
import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TagLabel, type TagInfo } from '@/components/TagLabel';
import { issueTag, type TagResult } from './actions';

/**
 * Issues the tag once, then either prints it or shows it full-size on screen (no printer / printer
 * down): the patient scans the QR with their phone camera or photographs the tag.
 */
export function TagPrinter({ eventId, regId, info, isReprint }: { eventId: string; regId: string; info: TagInfo; isReprint: boolean }) {
  const [state, action, pending] = useActionState<TagResult, FormData>(issueTag, {});
  const [mode, setMode] = useState<'print' | 'display'>('print');
  const router = useRouter();
  // refresh server data so the 'confirm' step appears (the label stays in client state)
  useEffect(() => {
    if (!state.qr) return;
    if (mode === 'print') setTimeout(() => window.print(), 300);
    router.refresh();
  }, [state.qr, router]); // eslint-disable-line react-hooks/exhaustive-deps -- mode is read once, when the tag arrives

  return (
    <div>
      {state.error ? <div className="alert alert-err no-print" role="alert">{state.error}</div> : null}
      {!state.qr ? (
        <form action={action} className="no-print">
          <input type="hidden" name="event_id" value={eventId} /><input type="hidden" name="reg_id" value={regId} />
          {isReprint ? (
            <div className="field"><label htmlFor="reason">Reason for a new tag (the previous tag&apos;s QR will stop working)</label>
              <input id="reason" name="reason" required placeholder="e.g. printer jam, damaged label, lost tag" /></div>
          ) : null}
          <div className="row">
            <button className="btn btn-accent btn-lg" disabled={pending} onClick={() => setMode('print')}>{pending && mode === 'print' ? 'Preparing…' : isReprint ? 'Reprint tag' : 'Print tag'}</button>
            <button className="btn btn-ghost btn-lg" disabled={pending} onClick={() => setMode('display')}>{pending && mode === 'display' ? 'Preparing…' : 'Display tag on screen'}</button>
          </div>
          <p className="small muted" style={{ margin: '8px 0 0' }}>No printer, or the printer is not working? <strong>Display tag on screen</strong> and let the patient scan the QR with their phone camera (or take a photo of it). Their phone then shows their progress and acts as their tag at every station.</p>
        </form>
      ) : (
        <>
          <div className="row no-print" style={{ marginBottom: 14 }}>
            <button className="btn btn-ghost" onClick={() => window.print()}>{mode === 'display' ? 'Print this tag' : `Print again (same tag v${state.version})`}</button>
            {mode === 'print' ? <button className="btn btn-ghost" onClick={() => setMode('display')}>Display on screen instead</button> : null}
            <button className="btn btn-ghost" onClick={() => savePng(info, state.qr!, state.bar!)}>Save as image</button>
          </div>
          {mode === 'display' ? (
            <div className="tag-display no-print" aria-label="Participant tag">
              <div className="small" style={{ fontWeight: 600 }}>Scan with your phone camera to see your tests and where to go next</div>
              <div className="td-qr" dangerouslySetInnerHTML={{ __html: state.qr }} />
              <div className="td-code">{info.code}</div>
              <div className="td-name">{info.name}</div>
              <div className="small">{info.pkg} · {info.event}</div>
              <div className="td-bar" dangerouslySetInnerHTML={{ __html: state.bar! }} />
              <div className="small" style={{ color: '#555' }}>Show this at every station. Keep it private — it opens your personal page.</div>
            </div>
          ) : null}
          {/* the printable label; in display mode it only appears on paper */}
          <div className={mode === 'display' ? 'print-only' : undefined}>
            <div style={{ background: '#fff', padding: 12, display: 'inline-block', borderRadius: 8 }}>
              <TagLabel info={info} qr={state.qr} bar={state.bar!} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const svgImage = (svg: string) => new Promise<HTMLImageElement>((ok, fail) => {
  const img = new Image();
  img.onload = () => ok(img); img.onerror = fail;
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
});

/** PNG of the tag (QR + code + name + barcode), e.g. to send to the patient's phone. */
async function savePng(info: TagInfo, qr: string, bar: string) {
  const W = 720, H = 1000, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#000'; g.textAlign = 'center';
  g.font = '600 26px Arial'; g.fillText('Scan to see your tests and next station', W / 2, 60);
  const [q, b] = await Promise.all([svgImage(qr), svgImage(bar)]);
  g.imageSmoothingEnabled = false;
  g.drawImage(q, 160, 90, 400, 400);
  g.font = '700 52px Arial'; g.fillText(info.code, W / 2, 570);
  g.font = '700 38px Arial'; g.fillText(info.name.slice(0, 32), W / 2, 625);
  g.font = '26px Arial'; g.fillText(`${info.pkg}`.slice(0, 48), W / 2, 670); g.fillText(info.event.slice(0, 48), W / 2, 706);
  g.drawImage(b, 80, 740, 560, 120);
  g.font = '22px Arial'; g.fillStyle = '#555'; g.fillText('Show this at every station. Keep it private.', W / 2, 920);
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png'); a.download = `tag-${info.code}.png`; a.click();
}
