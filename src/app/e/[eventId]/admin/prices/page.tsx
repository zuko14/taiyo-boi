import { AdminForm, isLive } from '@/components/AdminForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, Empty, PageHead, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { dt, inr } from '@/lib/format';
import { deactivatePrice, savePrice } from '../actions';

export default async function Prices({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await requirePerm(eventId, 'addon.price.edit');
  const back = `/e/${eventId}/admin/prices`;
  const live = isLive(ctx.event.status);
  const [{ data: prices }, { data: tests }] = await Promise.all([
    ctx.supabase.from('addon_prices').select('*, test_catalog(display_name, addon_available)').eq('event_id', eventId).order('created_at', { ascending: false }),
    ctx.supabase.from('test_catalog').select('id, display_name, addon_available').eq('event_id', eventId).eq('archived', false).order('display_name'),
  ]);
  return (
    <>
      <PageHead title="Add-on prices" meta="Employee-paid prices for tests outside the participant's package. Changing a price never alters existing orders." />
      <Card title="Prices">
        {prices?.length ? <div className="table-wrap"><table><thead><tr><th>Test</th><th>Price</th><th>Tax/fee</th><th>Where</th><th>Pay before service</th><th>Effective</th><th>Status</th><th></th></tr></thead>
          <tbody>{prices.map((p) => { const t = p.test_catalog as unknown as { display_name: string; addon_available: boolean }; return (
            <tr key={p.id}><td className="strong">{t.display_name}{!t.addon_available ? <div className="small muted">not offered as add-on</div> : null}</td><td>{inr(p.price_paise)}</td><td>{inr(p.tax_paise)}</td>
              <td>{p.location_scope.replace('_', ' ')}</td><td>{p.require_payment_before_service ? 'Yes' : 'No'}</td>
              <td className="small">{dt(p.effective_from, ctx.event.timezone)} → {p.effective_to ? dt(p.effective_to, ctx.event.timezone) : 'open'}</td>
              <td><StatusBadge status={p.active ? 'active' : 'closed'} label={p.active ? 'Active' : 'Inactive'} /></td>
              <td>{p.active ? <AdminForm action={deactivatePrice} eventId={eventId} back={back} live={live} hidden={{ id: p.id }} className="row"><SubmitButton className="btn btn-ghost btn-sm">Deactivate</SubmitButton></AdminForm> : null}</td></tr>); })}</tbody></table></div>
          : <Empty>No prices configured. Add-on prices must come from the Lab Partner / finance owner.</Empty>}
      </Card>
      <Card title="Add a price">
        <AdminForm action={savePrice} eventId={eventId} back={back} live={live}>
          <div className="form-row">
            <div className="field"><label>Test</label><select name="test_id" required>{(tests ?? []).map((t) => <option key={t.id} value={t.id}>{t.display_name}{t.addon_available ? '' : ' (enable add-on in catalogue)'}</option>)}</select></div>
            <div className="field"><label>Price (₹)</label><input name="price" inputMode="decimal" required /></div>
            <div className="field"><label>Tax / fee (₹)</label><input name="tax" inputMode="decimal" defaultValue="0" /></div>
            <div className="field"><label>Available at</label><select name="location_scope" defaultValue="both"><option value="both">Both</option><option value="event_day">Event day</option><option value="walk_in">Walk-in centre</option></select></div>
          </div>
          <div className="form-row">
            <div className="field"><label>Effective from</label><input type="datetime-local" name="effective_from" /></div>
            <div className="field"><label>Effective to</label><input type="datetime-local" name="effective_to" /></div>
            <label className="check" style={{ alignSelf: 'center' }}><input type="checkbox" name="require_payment" defaultChecked />Payment must be verified before the test</label>
          </div>
          <SubmitButton>Add price</SubmitButton>
        </AdminForm>
      </Card>
    </>
  );
}
