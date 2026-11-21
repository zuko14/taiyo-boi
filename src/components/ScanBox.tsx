import { CameraScan } from './CameraScan';
import { Icon } from './Icons';

/**
 * Keyboard-wedge scanner friendly: autofocus, Enter submits. Phone/tablet camera via CameraScan. Accepts tag QR URL or registration code.
 * `action` is a page URL (GET search) or a server action (e.g. the station's scan-and-start).
 */
export function ScanBox({ action, hidden, defaultValue, label = 'Scan tag or enter registration code' }:
  { action: string | ((fd: FormData) => Promise<void>); hidden?: Record<string, string | undefined>; defaultValue?: string; label?: string }) {
  return (
    <form {...(typeof action === 'string' ? { method: 'get', action } : { action })} className="row scan" role="search">
      {Object.entries(hidden ?? {}).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      <div className="search-bar" style={{ flex: 1, minWidth: 240 }}><Icon name="scan" />
        <input name="scan" defaultValue={defaultValue} placeholder={label} aria-label={label} autoFocus autoComplete="off" required /></div>
      <CameraScan />
      <button className="btn btn-solid">Find</button>
    </form>
  );
}
