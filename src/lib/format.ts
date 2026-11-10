// Display helpers. Money is integer paise; times are shown in the event's timezone.

export const inr = (paise: number | null | undefined) =>
  paise == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);

export const toPaise = (rupees: string) => {
  const n = Number(rupees);
  if (!Number.isFinite(n) || n < 0) throw new Error('Enter a valid amount');
  return Math.round(n * 100);
};

export function dt(iso: string | null | undefined, tz = 'Asia/Kolkata', withDate = true) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz, hour: '2-digit', minute: '2-digit',
    ...(withDate ? { day: '2-digit', month: 'short' } : {}),
  }).format(new Date(iso));
}

/** datetime-local input value in the event timezone -> ISO string */
export function localInputToIso(value: string, tz: string) {
  // shortcut: interprets the wall-clock time using the offset of that moment in tz; fine for IST (no DST)
  const guess = new Date(`${value}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(guess);
  const off = parts.find((p) => p.type === 'timeZoneName')?.value.replace('GMT', '') || '+00:00';
  return new Date(`${value}:00${off === '' ? '+00:00' : off}`).toISOString();
}

export function isoToLocalInput(iso: string | null | undefined, tz: string) {
  if (!iso) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

type Tone = 'green' | 'red' | 'blue' | 'amber' | '';
const STATUS: Record<string, [string, Tone]> = {
  // tasks / queue
  awaiting_choice: ['Choice needed', 'amber'], not_ready: ['Waiting turn', ''], waiting_unassigned: ['No station free', 'amber'],
  queued: ['Queued', 'blue'], called: ['Called', 'green'], in_service: ['In service', 'green'], completed: ['Completed', 'blue'],
  no_show: ['No-show', 'amber'], skipped: ['Skipped', ''], cancelled: ['Cancelled', 'red'], exception: ['Exception', 'red'],
  not_attended: ['Not attended', ''], checked_in: ['Checked in', 'green'], reassigned: ['Reassigned', ''],
  // payments
  pending: ['Payment pending', 'amber'], paid: ['Paid', 'green'], failed: ['Failed', 'red'], requires_review: ['Needs review', 'red'],
  refunded: ['Refunded', ''], partially_refunded: ['Partly refunded', 'amber'], waived: ['Waived', 'blue'], not_required: ['No charge', 'green'],
  // reports
  uploading: ['Uploading', 'amber'], uploaded_pending_validation: ['Pending validation', 'amber'], validated: ['Validated', 'blue'],
  published: ['Published', 'green'], replaced: ['Replaced', ''], withdrawn: ['Withdrawn', 'red'], upload_failed: ['Upload failed', 'red'],
  not_uploaded: ['Not uploaded yet', ''], processing: ['Processing', 'amber'], available: ['Report available', 'green'],
  // stations / events / registrations
  open: ['Open', 'green'], paused: ['Paused', 'amber'], closed: ['Closed', ''],
  draft: ['Draft', ''], ready: ['Ready', 'blue'], live: ['Live', 'green'], archived: ['Archived', ''],
  active: ['Active', 'green'], duplicate_void: ['Duplicate (void)', 'red'], ended: ['Ended', ''],
};

export const statusLabel = (s: string) => STATUS[s]?.[0] ?? s.replace(/_/g, ' ');
export const statusTone = (s: string): Tone => STATUS[s]?.[1] ?? '';
export const classLabel = (c: string) => (c === 'female' ? 'Female' : c === 'male' ? 'Male' : c);
export const locationLabel = (l: string) => (l === 'walk_in' ? 'Walk-in centre' : 'Event day');
