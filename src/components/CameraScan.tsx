'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from './Icons';

type Detector = { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> };
type DetectorCtor = { new (o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> };

/** Native BarcodeDetector (Android Chrome: QR + Code 128), else jsQR (iOS Safari, Firefox: QR only). */
async function makeDecoder(): Promise<(v: HTMLVideoElement, c: HTMLCanvasElement) => Promise<string | null>> {
  const BD = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  if (BD) {
    const supported = await BD.getSupportedFormats().catch(() => [] as string[]);
    const formats = ['qr_code', 'code_128'].filter((f) => supported.includes(f));
    if (formats.length) {
      const d = new BD({ formats });
      return async (v) => (await d.detect(v).catch(() => []))[0]?.rawValue ?? null;
    }
  }
  const jsQR = (await import('jsqr')).default;
  return async (v, c) => {
    const scale = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
    if (!w || !h) return null;
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(v, 0, 0, w, h);
    return jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' })?.data ?? null;
  };
}

function cameraError(e: unknown) {
  const n = (e as { name?: string })?.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Camera permission was denied. Allow camera access for this site in the browser settings, then try again.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No camera was found on this device.';
  if (n === 'NotReadableError') return 'The camera is in use by another app. Close it and try again.';
  return 'Could not start the camera. Type or use a scanner instead.';
}

const noop = () => () => {};

/** Camera button for a scan form: decodes the tag QR/barcode, fills input[name=scan] and submits the form. */
export function CameraScan() {
  const btn = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // false on the server and during hydration; camera needs HTTPS (or localhost)
  const available = useSyncExternalStore(noop, () => window.isSecureContext && !!navigator.mediaDevices?.getUserMedia, () => false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null; let stopped = false; let timer = 0;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
        if (stopped) return;
        const v = video.current!; v.srcObject = stream; await v.play();
        const decode = await makeDecoder();
        const tick = async () => {
          if (stopped) return;
          const value = v.readyState >= 2 ? (await decode(v, canvas.current!))?.trim() : null;
          if (stopped) return;
          if (value) {
            navigator.vibrate?.(60);
            const form = btn.current?.closest('form');
            const input = form?.querySelector<HTMLInputElement>('input[name="scan"]');
            setOpen(false);
            if (form && input) { input.value = value; form.requestSubmit(); }
            return;
          }
          timer = window.setTimeout(tick, 120);
        };
        tick();
      } catch (e) { if (!stopped) setError(cameraError(e)); }
    })();
    return () => {
      stopped = true; clearTimeout(timer); window.removeEventListener('keydown', onKey);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [open]);

  if (!available) return null;
  return (
    <>
      <button ref={btn} type="button" className="btn btn-ghost cam-btn" onClick={() => { setError(null); setOpen(true); }} aria-label="Scan with camera">
        <Icon name="camera" /><span>Camera</span>
      </button>
      {open ? (
        <div className="cam-overlay" role="dialog" aria-modal="true" aria-label="Camera scanner">
          <div className="cam-frame">
            <video ref={video} playsInline muted autoPlay />
            <div className="cam-target" aria-hidden="true" />
            <canvas ref={canvas} hidden />
          </div>
          <p className="cam-hint">{error ?? 'Point the camera at the QR code or barcode on the participant tag.'}</p>
          <button type="button" className="btn btn-solid" onClick={() => setOpen(false)} autoFocus>Close camera</button>
        </div>
      ) : null}
    </>
  );
}
