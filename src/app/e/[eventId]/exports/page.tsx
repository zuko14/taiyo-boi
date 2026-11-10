import { Icon } from '@/components/Icons';
import { Card, PageHead } from '@/components/ui';
import { requirePerm } from '@/lib/auth';

const LIST: [string, string, string[], string][] = [
  ['participants', 'Participant manifest', ['participant.view'], 'Codes, names, package, progress (mobile masked)'],
  ['station_workload', 'Station workload', ['dashboard.view'], 'Queue, in-service and completed counts per station'],
  ['test_completion', 'Test completion', ['dashboard.view', 'sponsor.view'], 'Per-test expected / appeared / completed'],
  ['sponsor_reconciliation', 'Sponsor reconciliation (counts)', ['sponsor.view'], 'Registered and appeared per package — no amounts'],
  ['walkin_pending', 'Walk-in pending list', ['participant.view'], 'Outstanding walk-in services'],
  ['addon_sales', 'Add-on sales', ['finance.view'], 'Add-on lines with price snapshot and payment state'],
  ['payment_reconciliation', 'Payment reconciliation', ['finance.view'], 'Verified/rejected transactions (references masked)'],
  ['report_status', 'Report status', ['report.view'], 'Report lifecycle per test line (no files)'],
];

export default async function Exports({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await requirePerm(eventId, 'export.run');
  return (
    <>
      <PageHead title="Exports" meta="CSV exports are logged in the audit trail and include only the fields your role allows." />
      <Card>
        <ul className="list">{LIST.filter(([, , perms]) => ctx.can(...perms)).map(([k, label, , desc]) => (
          <li key={k}><div><div className="strong">{label}</div><div className="small muted">{desc}</div></div>
            <a className="btn btn-ghost btn-sm" href={`/e/${eventId}/exports/${k}`}><Icon name="download" />CSV</a></li>))}</ul>
      </Card>
    </>
  );
}
