import type { ReactNode } from 'react';
import { statusLabel, statusTone } from '@/lib/format';

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <span className={`badge ${statusTone(status)}`}>{label ?? statusLabel(status)}</span>;
}

export function SourceTag({ source }: { source: string }) {
  return source === 'addon'
    ? <span className="badge plain tag-addon">Add-on · employee-paid</span>
    : <span className="badge plain tag-sponsor">Sponsored · ₹0</span>;
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'warn' | 'bad' }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <div className="label">{label}</div>
      <div className="num">{value}</div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function PageHead({ title, meta, children }: { title: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h2>{title}</h2>{meta ? <div className="meta">{meta}</div> : null}</div>
      {children ? <div className="row">{children}</div> : null}
    </div>
  );
}

export function Card({ title, sub, actions, children, className }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {title || actions ? (
        <div className="card-head"><div>{title ? <h3>{title}</h3> : null}{sub ? <div className="card-sub">{sub}</div> : null}</div>{actions}</div>
      ) : null}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
      <div className="dept-track" style={{ width: 90 }}><div className="dept-fill green" style={{ width: `${pct}%` }} /></div>
      <span className="small muted">{done}/{total}</span>
    </div>
  );
}
