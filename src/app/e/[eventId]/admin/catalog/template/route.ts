import { NextResponse } from 'next/server';
import { getEventContext } from '@/lib/auth';
import { TEMPLATE_COLUMNS } from '@/lib/catalog-import';
import { toCsv } from '@/lib/csv';

/** Catalogue CSV: blank template with examples, or ?current=1 for this event's tests (edit and re-upload). */
export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can('catalogue.view')) return new NextResponse('Forbidden', { status: 403 });
  const current = new URL(req.url).searchParams.get('current') === '1';
  let rows: Record<string, unknown>[];
  if (current) {
    const [{ data: tests }, { data: map }, { data: prices }] = await Promise.all([
      ctx.supabase.from('test_catalog').select('id, code, display_name, category, location, lab_order_code, instructions').eq('event_id', eventId).eq('archived', false).order('category').order('display_name'),
      ctx.supabase.from('workflow_service_tests').select('test_id, workflow_services(code)').eq('event_id', eventId),
      ctx.supabase.from('addon_prices').select('test_id, price_paise, created_at').eq('event_id', eventId).eq('active', true).order('created_at', { ascending: false }),
    ]);
    rows = (tests ?? []).map((t) => {
      const p = (prices ?? []).find((x) => x.test_id === t.id);
      const svc = (map ?? []).find((m) => m.test_id === t.id)?.workflow_services as unknown as { code: string } | undefined;
      return { code: t.code, name: t.display_name, category: t.category, price_inr: p ? (p.price_paise / 100).toFixed(2) : '',
        location: t.location, service: svc?.code ?? '', lab_order_code: t.lab_order_code ?? '', instructions: t.instructions };
    });
  } else {
    rows = [
      { code: 'CBC', name: 'CBC (Complete Blood Count)', category: 'Haematology', price_inr: '350', location: 'event_day', service: 'SAMPLE', lab_order_code: '', instructions: '' },
      { code: 'ECG', name: 'ECG', category: 'Cardiac', price_inr: '400', location: 'event_day', service: 'ECG', lab_order_code: '', instructions: '' },
      { code: 'USG-ABDOMEN', name: 'USG Whole Abdomen', category: 'Radiology', price_inr: '1500', location: 'walk_in', service: 'USG', lab_order_code: '', instructions: 'At the walk-in centre' },
    ];
  }
  const name = current ? `${ctx.event.code}-test-catalogue.csv` : 'test-catalogue-template.csv';
  return new NextResponse(toCsv(rows, [...TEMPLATE_COLUMNS]), { headers: {
    'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'private, no-store' } });
}
