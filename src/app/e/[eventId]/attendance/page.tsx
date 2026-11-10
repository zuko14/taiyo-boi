import { Card, PageHead, Stat } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { classLabel, locationLabel } from '@/lib/format';

type Sum = { classification: string; registered: number; appeared: number; with_package_attendance: number; all_package_lines_completed: number; adjustments: number };
type Row = { classification: string; test_code: string; test_name: string; location: string; expected: number; appeared: number; completed: number; pending: number; no_show: number; skipped: number; exception: number; walkin_outstanding: number };

// Counts only. Sponsor rates and payable amounts are backend-only and never rendered.
export default async function Attendance({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await requirePerm(eventId, 'sponsor.view', 'dashboard.view');
  const [{ data: sum }, { data: rows }] = await Promise.all([
    ctx.supabase.rpc('sponsor_summary', { p_event: eventId }),
    ctx.supabase.rpc('test_attendance', { p_event: eventId, p_source: 'package' }),
  ]);
  return (
    <>
      <PageHead title="Attendance counts" meta="Sponsored package attendance evidence. Repeated scans never increase counts. The settlement formula is not yet approved, so no amounts are calculated." />
      {((sum ?? []) as Sum[]).map((s) => (
        <div key={s.classification}>
          <h3 style={{ marginBottom: 10 }}>{classLabel(s.classification)} package</h3>
          <div className="stats">
            <Stat label="Registered" value={s.registered} /><Stat label="Appeared (unique)" value={s.appeared} />
            <Stat label="≥1 package test attended" value={s.with_package_attendance} /><Stat label="All package lines completed" value={s.all_package_lines_completed} />
            <Stat label="Recorded adjustments" value={s.adjustments} hint="skips, cancels, requeues, duplicates" />
          </div>
        </div>))}
      <Card title="Per test" sub="Registration alone is not attendance. Appeared = service started for that participant and test.">
        <div className="table-wrap"><table><thead><tr><th>Package</th><th>Test</th><th>Location</th><th>Expected</th><th>Appeared</th><th>Completed</th><th>Pending</th><th>No-show</th><th>Skipped</th><th>Exception</th><th>Walk-in outstanding</th></tr></thead>
          <tbody>{((rows ?? []) as Row[]).map((r) => (
            <tr key={r.classification + r.test_code}><td>{classLabel(r.classification)}</td><td className="strong">{r.test_name}</td><td>{locationLabel(r.location)}</td>
              <td>{r.expected}</td><td>{r.appeared}</td><td>{r.completed}</td><td>{r.pending}</td><td>{r.no_show}</td><td>{r.skipped}</td><td>{r.exception}</td><td>{r.walkin_outstanding}</td></tr>))}</tbody></table></div>
      </Card>
    </>
  );
}
