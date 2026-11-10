import Link from 'next/link';
import { ReasonAction, RpcForm } from '@/components/RpcForm';
import { ScanBox } from '@/components/ScanBox';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, Empty, PageHead, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { dt } from '@/lib/format';
import { resolveScan } from '@/lib/scan';
import { uploadReport } from './actions';

const TABS: [string, string, string[]][] = [
  ['review', 'Needs review', ['requires_review', 'upload_failed']],
  ['validate', 'Pending validation', ['uploaded_pending_validation']],
  ['publish', 'Validated', ['validated']],
  ['published', 'Published', ['published']],
  ['history', 'Replaced / withdrawn', ['replaced', 'withdrawn']],
];

export default async function Reports({ params, searchParams }: { params: Promise<{ eventId: string }>; searchParams: Promise<{ tab?: string; scan?: string; reg?: string }> }) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm(eventId, 'report.view');
  const tz = ctx.event.timezone;
  const tab = sp.tab ?? (ctx.can('report.upload') ? 'upload' : 'validate');
  const base = `/e/${eventId}/reports`;
  const back = `${base}?tab=${tab}`;

  let body = null;
  if (tab === 'upload') {
    const regId = sp.reg ?? (await resolveScan(ctx, sp.scan));
    let lines = null;
    if (regId) {
      const { data: reg } = await ctx.supabase.from('registrations').select('registration_code, participants(full_name)').eq('id', regId).maybeSingle();
      const { data: items } = await ctx.supabase.from('order_items').select('id, test_name, test_code, source, location, external_accession, reports(id, status, version)')
        .eq('registration_id', regId).eq('status', 'active').order('location').order('test_name');
      lines = reg ? (
        <Card title={`${reg.registration_code} · ${(reg.participants as unknown as { full_name: string }).full_name}`} sub="Choose the exact test line this report belongs to. Reports are never matched by name.">
          <form action={uploadReport} encType="multipart/form-data">
            <input type="hidden" name="event_id" value={eventId} /><input type="hidden" name="reg" value={regId} />
            <div className="table-wrap" style={{ marginBottom: 14 }}><table><thead><tr><th></th><th>Test</th><th>Reference</th><th>Reports</th></tr></thead>
              <tbody>{(items ?? []).map((i) => { const rs = (i.reports as { status: string; version: number }[]); return (
                <tr key={i.id}><td><input type="radio" name="order_item" value={i.id} required aria-label={i.test_name} /></td>
                  <td>{i.test_name} <span className="small muted">{i.source === 'addon' ? '· add-on' : ''}</span></td><td className="mono small">{i.external_accession ?? '—'}</td>
                  <td>{rs.length ? rs.sort((a, b) => b.version - a.version).slice(0, 1).map((r) => <StatusBadge key={r.version} status={r.status} label={`v${r.version} ${r.status.replace(/_/g, ' ')}`} />) : <span className="muted">none</span>}</td></tr>); })}</tbody></table></div>
            <div className="form-row">
              <div className="field"><label htmlFor="title">Report title</label><input id="title" name="title" defaultValue="Lab report" required /></div>
              <div className="field"><label htmlFor="acc">Accession / reference (if provided)</label><input id="acc" name="accession" /></div>
            </div>
            <div className="field"><label htmlFor="file">File (PDF, PNG or JPEG, up to 15 MB)</label><input id="file" name="file" type="file" accept="application/pdf,image/png,image/jpeg" required /></div>
            <SubmitButton>Upload report</SubmitButton>
          </form>
        </Card>) : <Card><Empty>Registration not found.</Empty></Card>;
    }
    body = (<>{ctx.can('report.upload') ? <Card><ScanBox action={base} hidden={{ tab: 'upload' }} /></Card> : <div className="alert alert-warn">You cannot upload reports.</div>}{lines}</>);
  } else {
    const states = TABS.find((t) => t[0] === tab)?.[2] ?? [];
    const { data: rows } = await ctx.supabase.from('reports')
      .select('id, title, status, status_reason, version, accession_ref, uploaded_at, published_at, uploaded_by, registration_id, registrations(registration_code), order_items(test_name, external_accession)')
      .eq('event_id', eventId).in('status', states).order('uploaded_at').limit(200);
    body = (
      <Card>
        {rows?.length ? <div className="table-wrap"><table><thead><tr><th>Participant</th><th>Test</th><th>Version</th><th>Reference</th><th>Uploaded</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{rows.map((r) => { const oi = r.order_items as unknown as { test_name: string; external_accession: string | null }; return (
            <tr key={r.id}>
              <td><Link className="mono strong" href={`/e/${eventId}/participants/${r.registration_id}`}>{(r.registrations as unknown as { registration_code: string }).registration_code}</Link></td>
              <td>{oi.test_name}</td><td>v{r.version}</td>
              <td className="small mono">{r.accession_ref ?? '—'}{oi.external_accession && r.accession_ref !== oi.external_accession ? <div className="badge red">expected {oi.external_accession}</div> : null}</td>
              <td>{dt(r.uploaded_at, tz)}</td><td><StatusBadge status={r.status} />{r.status_reason ? <div className="small muted">{r.status_reason}</div> : null}</td>
              <td><div className="row">
                <a className="btn btn-ghost btn-sm" href={`${base}/${r.id}/file`} target="_blank" rel="noopener noreferrer">View</a>
                {r.status === 'uploaded_pending_validation' && ctx.can('report.validate') ? <RpcForm eventId={eventId} rpc="report_action" back={back} ok="Validated" hidden={{ p_report: r.id, p_action: 'validate' }}><SubmitButton className="btn btn-solid btn-sm" disabled={r.uploaded_by === ctx.user.id && ctx.event.settings.report_maker_checker !== false}>Validate</SubmitButton></RpcForm> : null}
                {r.status === 'validated' && ctx.can('report.publish') ? <RpcForm eventId={eventId} rpc="report_action" back={back} ok="Published to participant" hidden={{ p_report: r.id, p_action: 'publish' }}><SubmitButton className="btn btn-green btn-sm" confirm="Publish this report to the participant?">Publish</SubmitButton></RpcForm> : null}
                {r.status === 'requires_review' && ctx.can('report.validate') ? <ReasonAction eventId={eventId} rpc="report_action" back={back} hidden={{ p_report: r.id, p_action: 'resolve_review' }} label="Mapping confirmed" /> : null}
                {['published', 'validated', 'uploaded_pending_validation', 'requires_review'].includes(r.status) && ctx.can('report.withdraw') ? <ReasonAction eventId={eventId} rpc="report_action" back={back} hidden={{ p_report: r.id, p_action: 'withdraw' }} label="Withdraw" danger /> : null}
              </div></td>
            </tr>); })}</tbody></table></div> : <Empty>No reports in this state.</Empty>}
      </Card>);
  }

  return (
    <>
      <PageHead title="Reports" meta="Only published reports are visible to participants, after identity verification.">
        <div className="toggle-group">
          {ctx.can('report.upload') ? <Link className={`toggle-btn ${tab === 'upload' ? 'on' : ''}`} href={`${base}?tab=upload`}>Upload</Link> : null}
          {TABS.map(([k, l]) => <Link key={k} className={`toggle-btn ${tab === k ? 'on' : ''}`} href={`${base}?tab=${k}`}>{l}</Link>)}
        </div>
      </PageHead>
      {body}
    </>
  );
}
