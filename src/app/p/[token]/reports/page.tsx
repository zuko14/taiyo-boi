import Link from 'next/link';
import { cookies } from 'next/headers';
import { Icon, KriyaMark } from '@/components/Icons';
import { SubmitButton } from '@/components/SubmitButton';
import { dt } from '@/lib/format';
import { serviceClient } from '@/lib/supabase/server';
import { sha256 } from '@/lib/tokens';
import { Invalid } from '../Invalid';
import { requestOtp, verifyOtp } from './actions';

type Rep = { report_id: string; title: string; test_name: string; version: number; published_at: string };

export default async function PortalReports({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ sent?: string; err?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return <Invalid />;
  const svc = serviceClient();
  const tokenHash = sha256(token);
  const { data: reg } = await svc.rpc('portal_registration', { p_token_hash: tokenHash });
  if (!reg) return <Invalid />;
  const session = (await cookies()).get('portal_s')?.value;
  const { data: reports, error } = session ? await svc.rpc('portal_reports', { p_token_hash: tokenHash, p_session_hash: sha256(session) }) : { data: null, error: true };

  return (
    <main className="portal"><div className="portal-inner">
      <div className="row-between" style={{ marginBottom: 16 }}><div className="brand"><KriyaMark /><span>Kriya AI</span></div>
        <Link className="btn btn-ghost btn-sm" href={`/p/${token}`}>Back to progress</Link></div>
      <div className="card">
        <h3>My reports</h3>
        {sp.err ? <div className="alert alert-err" role="alert" style={{ marginTop: 12 }}>{sp.err}</div> : null}
        {!error && reports ? (
          (reports as Rep[]).length ? (
            <ul className="list" style={{ marginTop: 10 }}>{(reports as Rep[]).map((r) => (
              <li key={r.report_id}><div><div className="strong">{r.test_name}</div><div className="small muted">{r.title} · v{r.version} · released {dt(r.published_at)}</div></div>
                <a className="btn btn-solid btn-sm" href={`/p/${token}/reports/${r.report_id}`} rel="noopener noreferrer"><Icon name="download" />Open</a></li>))}</ul>
          ) : <p className="text2" style={{ marginTop: 10 }}>No reports have been released yet. Check again later.</p>
        ) : sp.sent ? (
          <form action={verifyOtp} style={{ marginTop: 12 }}>
            <input type="hidden" name="token" value={token} />
            <div className="field"><label htmlFor="code">Enter the 6-digit code sent to your registered mobile</label>
              <input id="code" name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required autoFocus /></div>
            <SubmitButton className="btn btn-accent btn-block">Verify</SubmitButton>
          </form>
        ) : (
          <form action={requestOtp} style={{ marginTop: 12 }}>
            <input type="hidden" name="token" value={token} />
            <p className="small text2">For your privacy, reports need a one-time code sent to the mobile number you gave at registration.</p>
            <SubmitButton className="btn btn-accent btn-block">Send me a code</SubmitButton>
          </form>
        )}
      </div>
    </div></main>
  );
}
