import { Icon } from './Icons';

/** Keyboard-wedge scanner friendly: autofocus, Enter submits. Accepts tag QR URL or registration code. */
export function ScanBox({ action, hidden, defaultValue, label = 'Scan tag or enter registration code' }:
  { action: string; hidden?: Record<string, string | undefined>; defaultValue?: string; label?: string }) {
  return (
    <form method="get" action={action} className="row scan" role="search">
      {Object.entries(hidden ?? {}).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      <div className="search-bar" style={{ flex: 1, minWidth: 240 }}><Icon name="scan" />
        <input name="scan" defaultValue={defaultValue} placeholder={label} aria-label={label} autoFocus autoComplete="off" /></div>
      <button className="btn btn-solid">Find</button>
    </form>
  );
}
