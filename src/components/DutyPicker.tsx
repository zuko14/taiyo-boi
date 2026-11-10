import Link from 'next/link';
import type { DutyStation } from '@/lib/duty';
import { Card, Empty, StatusBadge } from './ui';

/** Lets staff pick which of their assigned counters/stations they are working at. */
export function DutyPicker({ stations, base, param = 'at', title, current }:
  { stations: DutyStation[]; base: string; param?: string; title: string; current?: string }) {
  if (!stations.length) {
    return <Card title={title}><Empty>You have no active shift here. Ask a supervisor to assign you to a counter/station for the current shift.</Empty></Card>;
  }
  return (
    <div className="row" style={{ marginBottom: 18 }}>
      <span className="label">{title}:</span>
      <div className="toggle-group" role="tablist">
        {stations.map((s) => (
          <Link key={s.id} href={`${base}?${param}=${s.id}`} className={`toggle-btn ${current === s.id ? 'on' : ''}`} role="tab" aria-selected={current === s.id}>
            {s.name}
          </Link>
        ))}
      </div>
      {stations.find((s) => s.id === current) ? <StatusBadge status={stations.find((s) => s.id === current)!.status} /> : null}
    </div>
  );
}
