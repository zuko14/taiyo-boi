import { qrSvg } from '@/lib/barcodes';
import { inr } from '@/lib/format';
import { upiLink, upiPayee } from '@/lib/upi';

/** Lab's UPI QR for one payment, prefilled with the amount and the registration code. */
export function UpiPay({ settings, amountPaise, reference, staff = true }:
  { settings: Record<string, unknown>; amountPaise: number; reference: string; staff?: boolean }) {
  const payee = upiPayee(settings);
  if (amountPaise <= 0) return null;
  if (!payee) return staff ? <p className="small muted" style={{ margin: '6px 0 0' }}>No UPI ID configured, so no QR is shown — collect cash, or add the lab&apos;s UPI ID in Event &amp; readiness → Operational settings.</p> : null;
  const link = upiLink(payee, amountPaise, reference);
  return (
    <div className="upi-pay">
      <div className="upi-qr" role="img" aria-label={`UPI QR code to pay ${inr(amountPaise)} to ${payee.name}`} dangerouslySetInnerHTML={{ __html: qrSvg(link) }} />
      <div className="upi-info">
        <div className="upi-amount">{inr(amountPaise)}</div>
        <div className="small text2">to <span className="strong">{payee.name}</span> · <span className="mono">{payee.vpa}</span></div>
        <div className="small text2">Note / reference: <span className="mono">{reference}</span></div>
        <a className="btn btn-solid btn-sm upi-open" href={link}>Open in UPI app</a>
        <p className="small muted" style={{ margin: 0 }}>{staff
          ? 'Scan with any UPI app (GPay, PhonePe, Paytm, BHIM). Cash also accepted. The test is queued once a cashier confirms the payment with its UTR.'
          : 'Scan with any UPI app, or tap the button on this phone. Show the payment confirmation (UTR) at the desk; your tests start once the payment is confirmed.'}</p>
      </div>
    </div>
  );
}
