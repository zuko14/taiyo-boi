import Link from 'next/link';
import type { Metadata } from 'next';
import { KriyaMark, Icon } from '@/components/Icons';
import { LiveRefresh } from '@/components/LiveRefresh';
import { StatusBadge } from '@/components/ui';
import { UpiPay } from '@/components/UpiPay';
import { dt, inr, locationLabel, statusLabel } from '@/lib/format';
import { rateLimited } from '@/lib/ratelimit';
import { serviceClient } from '@/lib/supabase/server';
import { sha256 } from '@/lib/tokens';
import { code128Svg, qrSvg } from '@/lib/barcodes';
import { env } from '@/lib/env';
import { Invalid } from './Invalid';

export const metadata: Metadata = { title: 'My health camp progress', referrer: 'no-referrer' };

type View = {
  event: { name: string; venue: string; help: string; instructions: string; timezone: string; lab_partner: string; status: string; upi_vpa: string | null; upi_payee_name: string | null;
    reports_until: string | null; reports_closed: boolean; reports_note: string | null };
  registration: { code: string; first_name: string; package: string; created_at: string; has_mobile: boolean };
  next_step: { service: string; station: string; station_code: string; staff: string | null; location: string; instructions: string; state: string; seq: number; ahead: number } | null;
  tasks: { id: string; service: string; location: string; source: string; status: string; items: { id: string; name: string; report: string }[] | null }[];
  walkin_centres: { name: string; address: string; hours: string; instructions: string; valid_from: string | null; valid_to: string | null }[];
  report_centres?: { name: string; address: string; hours: string; instructions: string }[];
  payments: { status: string; amount_paise: number; refunded_paise: number; receipt_no: string | null; items: string[]; kind: 'package' | 'addon' }[];
};

const STEP_TEXT: Record<string, string> = { queued: 'Please go to', called: 'You have been called — go now to', in_service: 'You are being attended at' };
const done = (s: string) => ['completed', 'skipped', 'cancelled'].includes(s);

export default async function Portal({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || (await rateLimited('portal', 120))) return <Invalid />;
  const { data } = await serviceClient().rpc('portal_view', { p_token_hash: sha256(token) });
  if (!data) return <Invalid />;
  const v = data as View;
  const tz = v.event.timezone;
  const pkgDay = v.tasks.filter((t) => t.source === 'package' && t.location === 'event_day');
  const pkgWalk = v.tasks.filter((t) => t.source === 'package' && t.location === 'walk_in');
  const addons = v.tasks.filter((t) => t.source === 'addon');
  const pct = (ts: typeof pkgDay) => (ts.length ? Math.round((ts.filter((t) => done(t.status)).length / ts.length) * 100) : 0);
  const pkgPay = v.payments.find((p) => p.kind === 'package');
  const due = v.payments.filter((p) => ['pending', 'requires_review'].includes(p.status));
  const upi = { upi_vpa: v.event.upi_vpa, upi_payee_name: v.event.upi_payee_name };
  const reportsAvailable = v.tasks.some((t) => (t.items ?? []).some((i) => i.report === 'available'));

  const taskList = (ts: typeof pkgDay) => (
    <ul className="list">{ts.map((t) => (
      <li key={t.id} style={{ display: 'block' }}>
        <div className="row-between"><span className="strong">{t.service}</span><StatusBadge status={t.status} /></div>
        <div className="row small" style={{ gap: 6, marginTop: 4 }}>{(t.items ?? []).map((i) => (
          <span key={i.id} className={`badge ${i.report === 'available' ? 'green' : 'plain'}`} title={statusLabel(i.report)}>{i.name}{i.report === 'available' ? ' · report' : ''}</span>))}
          {!t.items?.length && t.status === 'awaiting_choice' ? <span className="muted">Choose your option at the walk-in centre or help desk</span> : null}</div>
      </li>))}</ul>
  );

  return (
    <main className="portal">
      <div className="portal-inner">
        <div className="row-between" style={{ marginBottom: 16 }}>
          <div className="brand"><KriyaMark /><span>Kriya AI</span></div>
          <LiveRefresh pollMs={15000} />
        </div>
        <div className="card">
          <div className="small muted">{v.event.name}</div>
          <h2 style={{ fontSize: '1.4rem', marginTop: 4 }}>Hello {v.registration.first_name}</h2>
          <div className="row" style={{ marginTop: 8 }}><span className="mono strong">{v.registration.code}</span><span className="badge plain tag-sponsor">{v.registration.package}{pkgPay ? ` · ${inr(pkgPay.amount_paise)}` : ' · free of charge'}</span>
            {pkgPay ? <StatusBadge status={pkgPay.status} /> : null}</div>
        </div>

        {due.length ? (
          <div className="card" aria-live="polite">
            <h3>Payment due · {inr(due.reduce((n, p) => n + p.amount_paise, 0))}</h3>
            <p className="small text2">Your {due.some((p) => p.kind === 'package') ? 'package tests start' : 'add-on tests start'} once the payment is confirmed at the desk.</p>
            {due.map((p, i) => (
              <div key={i} style={{ marginTop: 10 }}>
                <div className="strong small">{p.kind === 'package' ? `Package · ${v.registration.package}` : `Add-on · ${p.items.join(', ')}`}</div>
                <UpiPay settings={upi} amountPaise={p.amount_paise} reference={v.registration.code} staff={false} />
              </div>))}
          </div>) : null}

        <section className="glass next-step" aria-live="polite">
          <div className="eyebrow">Your next step</div>
          {v.next_step ? (
            <>
              <div className="small text2" style={{ marginTop: 6 }}>{STEP_TEXT[v.next_step.state] ?? 'Next'}</div>
              <div className="where">{v.next_step.station === v.next_step.service ? v.next_step.station : `${v.next_step.service} — ${v.next_step.station}`} <span className="mono small muted">{v.next_step.station_code}</span></div>
              {v.next_step.staff ? <div className="text2" style={{ marginBottom: 6 }}>Staff: <strong>{v.next_step.staff}</strong> — tell them your code <span className="mono">{v.registration.code}</span></div> : null}
              <div className="row"><span className="ticket">#{v.next_step.seq}</span>
                <span className="text2">{v.next_step.state === 'queued' ? (v.next_step.ahead ? `${v.next_step.ahead} ahead of you` : 'You are next') : statusLabel(v.next_step.state)}</span></div>
              {v.next_step.location ? <div className="small text2" style={{ marginTop: 8 }}><Icon name="pin" /> {v.next_step.location}</div> : null}
              {v.next_step.instructions ? <div className="small text2">{v.next_step.instructions}</div> : null}
            </>
          ) : (
            <div className="where" style={{ fontSize: '1.2rem' }}>
              {pkgDay.every((t) => done(t.status)) ? 'All event-day services are complete.' : 'Please wait — you will be assigned to the next free station shortly.'}
            </div>
          )}
        </section>

        <div className="card">
          <div className="row-between"><h3>Event-day services</h3><span className="small muted">{pct(pkgDay)}%</span></div>
          <div className="usage-bar-track" style={{ margin: '10px 0' }}><div className="usage-bar-fill" style={{ width: `${pct(pkgDay)}%` }} /></div>
          {taskList(pkgDay)}
        </div>

        {pkgWalk.length ? (
          <div className="card">
            <div className="row-between"><h3>{locationLabel('walk_in')} services</h3><span className="small muted">{pct(pkgWalk)}%</span></div>
            <p className="small text2">These are part of your package but are done later at the walk-in centre.</p>
            {taskList(pkgWalk)}
            {v.walkin_centres.map((c) => (
              <div key={c.name} className="alert alert-info" style={{ marginTop: 12, display: 'block' }}>
                <div className="strong">{c.name}</div>
                <div className="small">{c.address || 'Address to be announced'}{c.hours ? ` · ${c.hours}` : ''}</div>
                {c.valid_from || c.valid_to ? <div className="small">Valid {c.valid_from ?? ''} – {c.valid_to ?? ''}</div> : null}
                {c.instructions ? <div className="small">{c.instructions}</div> : null}
              </div>))}
          </div>) : null}

        {addons.length ? (
          <div className="card">
            <h3>Add-on tests (paid by you)</h3>
            {taskList(addons)}
            <ul className="list">{v.payments.filter((p) => p.kind === 'addon').map((p, i) => (
              <li key={i}><span>{p.items.join(', ')} · {inr(p.amount_paise)}{p.receipt_no ? <span className="small muted"> · receipt {p.receipt_no}</span> : null}</span><StatusBadge status={p.status} /></li>))}</ul>
          </div>) : null}

        <div className="card">
          <h3>Reports</h3>
          {v.event.reports_closed ? (<>
            <p className="small text2">{v.event.reports_note || 'Online viewing of reports has ended. Please collect your reports at the walk-in centre — bring your tag or registration code.'}</p>
            {(v.report_centres ?? []).map((c) => (
              <div key={c.name} className="alert alert-info" style={{ marginTop: 8, display: 'block' }}>
                <div className="strong">{c.name}</div>
                <div className="small">{c.address || 'Address at the help desk'}{c.hours ? ` · ${c.hours}` : ''}</div>
                {c.instructions ? <div className="small">{c.instructions}</div> : null}
              </div>))}
          </>) : (<>
            <p className="small text2">{reportsAvailable ? 'Some reports are available.' : 'Reports appear here after the laboratory uploads and releases them.'} You will be asked for a one-time code sent to your registered mobile.{v.event.reports_until ? ` Available online until ${dt(new Date(new Date(v.event.reports_until).getTime() - 60_000).toISOString(), tz)}; after that, collect them at the walk-in centre.` : ''}</p>
            <Link className="btn btn-accent btn-block" href={`/p/${token}/reports`}><Icon name="lock" />View my reports</Link>
          </>)}
        </div>

        <details className="card">
          <summary className="strong" style={{ cursor: 'pointer' }}>Show my tag (QR for the station staff)</summary>
          <div className="tag-display" style={{ marginTop: 12 }}>
            <div className="td-qr" dangerouslySetInnerHTML={{ __html: qrSvg(`${env().APP_URL}/p/${token}`) }} />
            <div className="td-code">{v.registration.code}</div>
            <div className="td-bar" dangerouslySetInnerHTML={{ __html: code128Svg(v.registration.code) }} />
            <div className="small" style={{ color: '#555' }}>Show this screen at each station. Do not share it — it opens your personal page.</div>
          </div>
        </details>

        <div className="card small text2">
          <div className="strong">Need help?</div>
          <div>{v.event.help || 'Please ask at the help desk.'}</div>
          {v.event.instructions ? <div style={{ marginTop: 6 }}>{v.event.instructions}</div> : null}
          <div className="muted" style={{ marginTop: 6 }}>Registered {dt(v.registration.created_at, tz)}. Only you can see this page — keep your tag safe.</div>
        </div>
      </div>
    </main>
  );
}
