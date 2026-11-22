import { inr } from '@/lib/format';
import { Empty } from './ui';

export type ReferralRow = { kind: 'camp' | 'outside' | 'none'; doctor_id: string | null; name: string; specialization: string; patients: number; orders: number;
  tests: number; ordered_paise: number; collected_paise: number; pending_paise: number };

/** "Referred by" on a desk form: a camp doctor, or an outside doctor's name (not both). */
export function ReferralFields({ doctors, help }: { doctors: { id: string; name: string; specialization: string }[]; help?: string }) {
  return (
    <div className="form-row">
      <div className="field"><label htmlFor="referred_doctor">Referred by (camp doctor)</label>
        <select id="referred_doctor" name="referred_doctor" defaultValue=""><option value="">— not referred —</option>
          {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}{d.specialization ? ` — ${d.specialization}` : ''}</option>)}</select>
        {help ? <span className="help">{help}</span> : null}</div>
      <div className="field"><label htmlFor="referred_name">…or outside doctor&apos;s name</label>
        <input id="referred_name" name="referred_name" maxLength={120} placeholder="e.g. Dr. S. Reddy, City Clinic" /></div>
    </div>
  );
}

/** Referrers with the patients, tests and money their referrals brought (collected = verified − refunds). */
export function ReferralTable({ rows, money = true }: { rows: ReferralRow[]; money?: boolean }) {
  const referred = rows.filter((r) => r.kind !== 'none');
  if (!referred.length) return <Empty>No referrals recorded yet.</Empty>;
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Referred by</th><th>Patients</th><th>Tests</th>{money ? <><th>Ordered</th><th>Collected</th><th>Pending</th></> : null}</tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={`${r.kind}-${r.doctor_id ?? r.name}`} className={r.kind === 'none' ? 'muted' : undefined}>
          <td><span className="strong">{r.name}</span> <span className="small muted">{r.kind === 'camp' ? `camp doctor${r.specialization ? ` · ${r.specialization}` : ''}` : r.kind === 'outside' ? 'outside doctor' : ''}</span></td>
          <td>{r.patients}</td><td>{r.tests}</td>
          {money ? <><td>{inr(r.ordered_paise)}</td><td className="strong">{inr(r.collected_paise)}</td><td>{inr(r.pending_paise)}</td></> : null}</tr>))}
        {money ? <tr className="strong"><td>Total</td><td>—</td><td>{rows.reduce((n, r) => n + r.tests, 0)}</td><td>{inr(rows.reduce((n, r) => n + r.ordered_paise, 0))}</td>
          <td>{inr(rows.reduce((n, r) => n + r.collected_paise, 0))}</td><td>{inr(rows.reduce((n, r) => n + r.pending_paise, 0))}</td></tr> : null}
      </tbody></table></div>
  );
}
