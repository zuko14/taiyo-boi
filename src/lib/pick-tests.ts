import 'server-only';
import type { EventContext } from '@/lib/auth';
import { nowMs } from '@/lib/clock';
import type { PickTest } from '@/components/TestPicker';

/** Every active test with its current price (null = not on sale). Display only: the database recomputes prices. */
export async function loadPickTests(ctx: EventContext): Promise<PickTest[]> {
  const [{ data: tests }, { data: prices }] = await Promise.all([
    // every active test is listed (unpriced ones greyed out) so the desk never "loses" ECG, 2D Echo…
    ctx.supabase.from('test_catalog').select('id, code, display_name, category, location, addon_available').eq('event_id', ctx.event.id).eq('active', true).eq('archived', false).order('category').order('display_name'),
    ctx.supabase.from('addon_prices').select('test_id, price_paise, tax_paise, mrp_paise, discount_pct, location_scope, effective_from, effective_to').eq('event_id', ctx.event.id).eq('active', true).order('effective_from', { ascending: false }),
  ]);
  const now = nowMs();
  return (tests ?? []).map((t) => {
    const p = t.addon_available ? (prices ?? []).find((x) => x.test_id === t.id && (x.location_scope === 'both' || x.location_scope === t.location)
      && new Date(x.effective_from).getTime() <= now && (!x.effective_to || new Date(x.effective_to).getTime() > now)) : undefined;
    return { id: t.id, code: t.code, name: t.display_name, category: t.category, location: t.location, price_paise: p ? p.price_paise + p.tax_paise : null,
      mrp_paise: p && Number(p.discount_pct) > 0 ? p.mrp_paise! + p.tax_paise : null, discount_pct: p ? Number(p.discount_pct) : 0 };
  });
}
