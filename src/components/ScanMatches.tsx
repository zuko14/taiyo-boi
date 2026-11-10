import Link from 'next/link';
import type { ScanMatch } from '@/lib/scan';
import { classLabel } from '@/lib/format';
import { Card, StatusBadge } from './ui';

/** Candidates for a name / partial search. Staff must pick one; nothing is chosen automatically. */
export function ScanMatches({ query, matches, hrefFor }: { query: string; matches: ScanMatch[]; hrefFor: (id: string) => string }) {
  if (!matches.length) return <div className="alert alert-err">No registration found for “{query}”. Try the registration code, employee ID or mobile number.</div>;
  return (
    <Card>
      <div className="label" style={{ marginBottom: 8 }}>{matches.length === 10 ? 'First 10 matches' : `${matches.length} match(es)`} for “{query}” — confirm the participant before continuing</div>
      <ul className="list">{matches.map((m) => (
        <li key={m.id}><Link className="strong" href={hrefFor(m.id)}><span className="mono">{m.registration_code}</span> · {m.full_name}</Link>
          <span className="row small"><span className="muted">{classLabel(m.classification)}</span>{m.status !== 'active' ? <StatusBadge status={m.status} /> : null}</span></li>))}</ul>
    </Card>
  );
}
