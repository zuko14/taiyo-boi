/** UPI collection details configured by the event admin (the lab's own UPI ID / merchant VPA). */
export const VPA_RE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;

export function upiPayee(settings: Record<string, unknown>) {
  const vpa = String(settings.upi_vpa ?? '').trim();
  if (!VPA_RE.test(vpa)) return null;
  return { vpa, name: String(settings.upi_payee_name ?? '').trim() || vpa };
}

/**
 * NPCI "upi://pay" deep link with the exact amount and the registration code as the note, so the
 * cashier can match the UTR. Scanning it does NOT confirm payment: a cashier still verifies it.
 */
export function upiLink(payee: { vpa: string; name: string }, amountPaise: number, note: string) {
  const q = new URLSearchParams({ pa: payee.vpa, pn: payee.name, am: (amountPaise / 100).toFixed(2), cu: 'INR', tn: note.slice(0, 50) });
  // spaces as %20 and a literal @ in the VPA: several UPI apps reject '+' and '%40'
  return `upi://pay?${q.toString().replace(/\+/g, '%20').replace(/%40/g, '@')}`;
}
