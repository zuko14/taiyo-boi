import Link from 'next/link';
import { LiveRefresh } from '@/components/LiveRefresh';
import { Card, Empty, PageHead, Stat } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { env } from '@/lib/env';
import { dt, inr } from '@/lib/format';

type Insights = {
  totals: { collected_paise: number; payments: number; paying_participants: number; first_at: string | null; last_at: string | null };
  refunded_paise: number;
  open: { pending_paise: number; pending_count: number; review_count: number; waived_paise: number; failed_paise: number };
  by_source: { source: 'package' | 'addon'; collected_paise: number; pending_paise: number; payments: number }[];
  by_method: { method: string; count: number; amount_paise: number }[];
  timeline: { hour: string; amount_paise: number; count: number }[];
  top_items: { kind: 'package' | 'addon'; name: string; count: number; amount_paise: number }[];
  by_cashier: { name: string; count: number; amount_paise: number }[];
  registrations: number;
};

const METHOD: Record<string, string> = { cash: 'Cash', upi_manual: 'UPI (lab QR)' };
const SOURCE: Record<string, string> = { package: 'Packages', addon: 'Add-on tests' };
const compact = (paise: number) => {
  const r = paise / 100;
  return r >= 1e7 ? `₹${(r / 1e7).toFixed(1)}Cr` : r >= 1e5 ? `₹${(r / 1e5).toFixed(1)}L` : r >= 1e3 ? `₹${(r / 1e3).toFixed(r >= 1e4 ? 0 : 1)}k` : `₹${Math.round(r)}`;
};
/** Four gridline steps of a 1-2-5 "nice" size, so ticks read ₹0 / ₹1k / ₹2k / ₹3k. */
function niceScale(v: number) {
  const raw = Math.max(v, 100) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * p).find((m) => m >= raw)!;
  const top = step * Math.ceil(v / step || 1);
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}
/** Top-rounded bar (4px data end), square at the baseline. */
const barPath = (x: number, y: number, w: number, h: number) => {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};

/** Hourly (or daily, past 48 h) buckets with empty slots filled so the time axis is honest. */
function buckets(t: Insights['timeline']) {
  if (!t.length) return [];
  const toMs = (h: string) => Date.parse(`${h}:00Z`);       // local wall-clock hours, arithmetic only
  const first = toMs(t[0].hour), last = toMs(t[t.length - 1].hour);
  const byHour = new Map(t.map((x) => [toMs(x.hour), x]));
  const hours = Math.round((last - first) / 3_600_000) + 1;
  const out: { label: string; sub: string; amount: number; count: number }[] = [];
  const day = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  if (hours <= 48) {
    for (let i = 0; i < hours; i++) {
      const ms = first + i * 3_600_000; const x = byHour.get(ms);
      out.push({ label: `${String(new Date(ms).getUTCHours()).padStart(2, '0')}:00`, sub: day(ms), amount: x?.amount_paise ?? 0, count: x?.count ?? 0 });
    }
  } else {
    const days = new Map<string, { amount: number; count: number }>();
    for (const x of t) { const k = x.hour.slice(0, 10); const d = days.get(k) ?? { amount: 0, count: 0 }; d.amount += x.amount_paise; d.count += x.count; days.set(k, d); }
    for (let ms = Date.parse(`${t[0].hour.slice(0, 10)}T00:00Z`); ms <= last; ms += 86_400_000) {
      const k = new Date(ms).toISOString().slice(0, 10); const d = days.get(k);
      out.push({ label: day(ms), sub: '', amount: d?.amount ?? 0, count: d?.count ?? 0 });
    }
  }
  return out;
}

function TimelineChart({ data }: { data: ReturnType<typeof buckets> }) {
  const W = 680, H = 250, L = 64, R = 8, T = 12, B = 34;
  const { top: max, ticks } = niceScale(Math.max(...data.map((d) => d.amount)));
  const step = (W - L - R) / data.length;
  const bw = Math.max(4, Math.min(44, step - 2));               // >=2px surface gap between bars
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const every = Math.ceil(data.length / 12);
  return (
    <svg className="viz-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Verified collections over time">
      {ticks.map((v) => (
        <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="viz-grid" />
          <text x={L - 8} y={y(v) + 4} textAnchor="end" className="viz-tick">{compact(v)}</text></g>))}
      {data.map((d, i) => {
        const x = L + i * step + (step - bw) / 2;
        return (
          <g key={i} className="viz-hit">
            <rect x={L + i * step} y={T} width={step} height={H - T - B} fill="transparent" />
            {d.amount > 0 ? <path d={barPath(x, y(d.amount), bw, y(0) - y(d.amount))} className="viz-s1" /> : null}
            <title>{`${d.sub ? d.sub + ' ' : ''}${d.label} — ${inr(d.amount)} from ${d.count} payment${d.count === 1 ? '' : 's'}`}</title>
            {i % every === 0 ? <text x={L + i * step + step / 2} y={H - B + 22} textAnchor="middle" className="viz-tick">{d.label}</text> : null}
          </g>);
      })}
      <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} className="viz-axis" />
    </svg>
  );
}

/** Ranked horizontal bars, one hue (magnitude), value labelled at the end. */
function RankBars({ rows }: { rows: { label: string; tag?: string; amount: number; hint: string }[] }) {
  const max = Math.max(...rows.map((r) => r.amount), 1);
  return (
    <ul className="rank">
      {rows.map((r) => (
        <li key={r.label + (r.tag ?? '')} title={`${r.label} — ${inr(r.amount)} · ${r.hint}`}>
          <div className="rank-head"><span className="rank-name">{r.label}{r.tag ? <span className="badge plain" style={{ marginLeft: 8 }}>{r.tag}</span> : null}</span>
            <span className="rank-val">{inr(r.amount)}</span></div>
          <div className="rank-track"><div className="rank-fill" style={{ width: `${Math.max(1.5, (r.amount / max) * 100)}%` }} /></div>
          <div className="small muted">{r.hint}</div>
        </li>))}
    </ul>
  );
}

export default async function Revenue({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await requirePerm(eventId, 'finance.view');
  const { data } = await ctx.supabase.rpc('revenue_insights', { p_event: eventId });
  const v = data as Insights;
  const tz = ctx.event.timezone;
  const net = v.totals.collected_paise - v.refunded_paise;
  const avg = v.totals.paying_participants ? Math.round(net / v.totals.paying_participants) : 0;
  const conv = v.registrations ? Math.round((v.totals.paying_participants / v.registrations) * 100) : 0;
  const rate = net + v.open.pending_paise > 0 ? Math.round((net / (net + v.open.pending_paise)) * 100) : 0;
  const series = buckets(v.timeline);
  const peak = series.reduce((a, b) => (b.amount > (a?.amount ?? -1) ? b : a), series[0]);
  const src = (['package', 'addon'] as const).map((s) => v.by_source.find((x) => x.source === s) ?? { source: s, collected_paise: 0, pending_paise: 0, payments: 0 });
  const srcTotal = src.reduce((n, s) => n + Math.max(0, s.collected_paise), 0);

  return (
    <div className="viz">
      <PageHead title="Revenue insights" meta="Money actually received from participants: verified cash and UPI payments, less refunds. Orders and displayed QR codes are never counted.">
        <LiveRefresh eventId={eventId} tables={['payment_intents', 'registrations']} url={env().NEXT_PUBLIC_SUPABASE_URL} anonKey={env().NEXT_PUBLIC_SUPABASE_ANON_KEY} />
        <Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/payments`}>Payments</Link>
        <Link className="btn btn-ghost btn-sm" href={`/e/${eventId}/finance`}>Add-on detail</Link>
      </PageHead>

      <section className="card rev-hero">
        <div>
          <div className="label">Net collected</div>
          <div className="hero-num">{inr(net)}</div>
          <div className="text2 small">{v.totals.payments} verified payment{v.totals.payments === 1 ? '' : 's'} from {v.totals.paying_participants} participant{v.totals.paying_participants === 1 ? '' : 's'}
            {v.totals.last_at ? ` · last at ${dt(v.totals.last_at, tz)}` : ''}</div>
        </div>
        <div className="rev-gauge" aria-label={`${rate}% of billed money collected`}>
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle cx="60" cy="60" r="50" className="viz-track" />
            <circle cx="60" cy="60" r="50" className="viz-ring" pathLength={100} strokeDasharray={`${rate} 100`} transform="rotate(-90 60 60)" />
          </svg>
          <div className="rev-gauge-num"><strong>{rate}%</strong><span className="small muted">collected</span></div>
        </div>
      </section>

      <div className="stats">
        <Stat label="Pending collection" value={inr(v.open.pending_paise)} hint={`${v.open.pending_count} payment${v.open.pending_count === 1 ? '' : 's'} waiting`} tone={v.open.pending_count ? 'warn' : undefined} />
        <Stat label="Needs review" value={v.open.review_count} hint="amount mismatch / duplicate UTR" tone={v.open.review_count ? 'bad' : undefined} />
        <Stat label="Avg per paying participant" value={inr(avg)} />
        <Stat label="Paying participants" value={`${conv}%`} hint={`${v.totals.paying_participants} of ${v.registrations} registered`} />
        <Stat label="Refunded" value={inr(v.refunded_paise)} hint={v.open.waived_paise ? `${inr(v.open.waived_paise)} waived` : undefined} />
      </div>

      <Card title="Collections over time" sub={peak && peak.amount > 0 ? `Peak ${peak.sub ? peak.sub + ' ' : ''}${peak.label}: ${inr(peak.amount)}. Hover a bar for details. Times in ${tz}.` : 'Verified payments by hour'}>
        {series.length ? <TimelineChart data={series} /> : <Empty>No verified payments yet. Revenue appears here as soon as a cashier verifies the first payment.</Empty>}
        {series.length ? (
          <details style={{ marginTop: 8 }}><summary className="small muted" style={{ cursor: 'pointer' }}>View as table</summary>
            <div className="table-wrap"><table><thead><tr><th>Time</th><th>Payments</th><th>Collected</th></tr></thead>
              <tbody>{series.filter((d) => d.count).map((d, i) => <tr key={i}><td>{d.sub} {d.label}</td><td>{d.count}</td><td>{inr(d.amount)}</td></tr>)}</tbody></table></div>
          </details>) : null}
      </Card>

      <div className="grid grid-2">
        <Card title="Packages vs add-on tests" sub="Net collected by what was sold">
          {srcTotal > 0 ? (
            <>
              <div className="split" role="img" aria-label={src.map((s) => `${SOURCE[s.source]} ${inr(s.collected_paise)}`).join(', ')}>
                {src.filter((s) => s.collected_paise > 0).map((s) => (
                  <div key={s.source} className={`split-seg ${s.source === 'package' ? 'viz-s1' : 'viz-s2'}`} style={{ flexGrow: s.collected_paise }} title={`${SOURCE[s.source]} — ${inr(s.collected_paise)}`} />))}
              </div>
              <ul className="legend">{src.map((s) => (
                <li key={s.source}><span className={`swatch ${s.source === 'package' ? 'viz-s1' : 'viz-s2'}`} />
                  <span className="strong">{SOURCE[s.source]}</span><span className="text2">{inr(s.collected_paise)} · {srcTotal ? Math.round((Math.max(0, s.collected_paise) / srcTotal) * 100) : 0}%</span>
                  <span className="small muted">{s.payments} paid{s.pending_paise ? ` · ${inr(s.pending_paise)} pending` : ''}</span></li>))}</ul>
            </>) : <Empty>Nothing collected yet.</Empty>}
        </Card>
        <Card title="By payment method" sub="Verified amounts">
          {v.by_method.length ? <RankBars rows={v.by_method.map((m) => ({ label: METHOD[m.method] ?? m.method, amount: m.amount_paise, hint: `${m.count} payment${m.count === 1 ? '' : 's'}` }))} /> : <Empty>No verified payments yet.</Empty>}
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Top earners" sub="Packages and add-on tests ranked by money collected">
          {v.top_items.length ? <RankBars rows={v.top_items.slice(0, 8).map((t) => ({ label: t.name, tag: t.kind === 'package' ? 'Package' : 'Add-on', amount: t.amount_paise, hint: `${t.count} sold · paid` }))} />
            : <Empty>No paid packages or add-ons yet.</Empty>}
        </Card>
        <Card title="By cashier" sub="Who verified the money">
          {v.by_cashier.length ? <RankBars rows={v.by_cashier.map((c) => ({ label: c.name, amount: c.amount_paise, hint: `${c.count} payment${c.count === 1 ? '' : 's'} verified` }))} /> : <Empty>No verified payments yet.</Empty>}
        </Card>
      </div>
      {ctx.event.settings.package_mode === 'female_male'
        ? <p className="small muted">Sponsored Female/Male package rates are not participant payments and are never shown here.</p> : null}
    </div>
  );
}
