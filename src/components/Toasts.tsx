'use client';
import { useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/** Shows ?ok= / ?err= flash messages from server actions. Success messages clear themselves. */
export function Toasts() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const ok = params.get('ok'); const err = params.get('err');
  const clear = () => {
    const rest = new URLSearchParams(params); rest.delete('ok'); rest.delete('err');
    router.replace(path + (rest.size ? `?${rest}` : ''), { scroll: false });
  };
  useEffect(() => {
    if (!ok || err) return;
    const t = setTimeout(clear, 5000);
    return () => clearTimeout(t);
  });
  if (!ok && !err) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {[ok && { kind: 'ok', text: ok }, err && { kind: 'err', text: err }].filter(Boolean).map((m) => m && (
        <div key={m.kind} className={`toast toast-${m.kind}`} role={m.kind === 'err' ? 'alert' : undefined}>
          <div className="row-between" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
            <span>{m.text}</span>
            <button className="btn btn-ghost btn-sm" onClick={clear} aria-label="Dismiss">×</button>
          </div>
        </div>
      ))}
    </div>
  );
}
