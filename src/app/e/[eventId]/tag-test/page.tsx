import { TagLabel } from '@/components/TagLabel';
import { Card, PageHead } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { code128Svg, qrSvg } from '@/lib/barcodes';
import { labelSettings } from '@/lib/label';
import { PrintButton } from './PrintButton';

// Test print with synthetic data: verify label size, margins and scanner readability before event day.
export default async function TagTest({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await requirePerm(eventId, 'event.configure', 'registration.create');
  const l = labelSettings(ctx.event.settings);
  const code = `${String(ctx.event.code_prefix ?? 'BOI')}-F-${String(ctx.event.code_year ?? '')}-000000`;
  return (
    <>
      <div className="no-print"><PageHead title="Test print" meta={`Label ${l.w} × ${l.h} mm · synthetic data · not a participant`}><PrintButton /></PageHead>
        <Card><p className="small text2">Print on the real label stock and printer, then scan the barcode and QR with the event scanners and phones. The QR here opens nothing.</p></Card></div>
      <div style={{ background: '#fff', padding: 12, display: 'inline-block', borderRadius: 8 }}>
        <TagLabel info={{ code, name: 'TEST PRINT – SAMPLE NAME', age: 40, pkg: 'Package name', event: ctx.event.name, showAge: l.showAge, w: l.w, h: l.h }}
          qr={qrSvg('TEST-PRINT-NOT-A-PARTICIPANT')} bar={code128Svg(code)} />
      </div>
    </>
  );
}
