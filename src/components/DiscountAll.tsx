import { AdminForm } from './AdminForm';
import { SubmitButton } from './SubmitButton';
import { applyDiscount } from '@/app/e/[eventId]/admin/actions';

/** One discount % for every priced test (or one category), optionally the packages too. */
export function DiscountAll({ eventId, back, live, categories, packages }: { eventId: string; back: string; live: boolean; categories: string[]; packages: boolean }) {
  return (
    <AdminForm action={applyDiscount} eventId={eventId} back={back} live={live}>
      <div className="form-row" style={{ alignItems: 'flex-end' }}>
        <div className="field"><label htmlFor="dall">Discount %</label><input id="dall" name="discount_pct" inputMode="decimal" required placeholder="e.g. 20" /></div>
        <div className="field"><label htmlFor="dcat">Apply to</label><select id="dcat" name="category" defaultValue="">
          <option value="">All priced tests</option>{categories.map((c) => <option key={c} value={c}>Category: {c}</option>)}</select></div>
        {packages ? <label className="check" style={{ alignSelf: 'center' }}><input type="checkbox" name="include_packages" />Also packages</label> : null}
      </div>
      <p className="small muted" style={{ margin: '0 0 8px' }}>The discount is taken off each test&apos;s original price (it never stacks). Free tests stay free. <strong>0</strong> removes the discount and restores the original prices. Patients already registered keep the price they were charged.</p>
      <SubmitButton confirm="Apply this discount to the selected test prices?">Apply discount</SubmitButton>
    </AdminForm>
  );
}
