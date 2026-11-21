import { NextResponse } from 'next/server';
import { getEventContext } from '@/lib/auth';
import { PACKAGE_TEMPLATE_COLUMNS } from '@/lib/catalog-import';
import { toCsv } from '@/lib/csv';

/** Package CSV: template with examples, or ?current=1 for this event's packages (one row per test). */
export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can('package.view')) return new NextResponse('Forbidden', { status: 403 });
  const current = new URL(req.url).searchParams.get('current') === '1';
  let rows: Record<string, unknown>[];
  if (current) {
    const [{ data: pkgs }, { data: lines }] = await Promise.all([
      ctx.supabase.from('packages').select('id, code, name, code_letter, price_paise, description').eq('event_id', eventId).neq('code', 'PAY_PER_TEST').order('code'),
      ctx.supabase.from('package_tests').select('package_id, test_catalog(code)').eq('event_id', eventId).is('choice_group_id', null),
    ]);
    rows = (pkgs ?? []).flatMap((p) => {
      const tests = (lines ?? []).filter((l) => l.package_id === p.id).map((l) => (l.test_catalog as unknown as { code: string }).code).sort();
      const head = { package_code: p.code, package_name: p.name, code_letter: p.code_letter, price_inr: p.price_paise ? (p.price_paise / 100).toFixed(2) : '', description: p.description };
      return tests.length ? tests.map((t, i) => (i ? { package_code: p.code, test: t } : { ...head, test: t })) : [{ ...head, test: '' }];
    });
  } else {
    rows = [
      { package_code: 'AARUSH', package_name: 'Taiyo Aarush Executive Plus', code_letter: 'A', price_inr: '4499', description: 'Executive health check', test: 'FBS; HBA1C; CBC; LIPID-PROFILE' },
      { package_code: 'AARUSH', test: '2D Echo' },
      { package_code: 'AARUSH', test: 'X-Ray Chest' },
      { package_code: 'BASIC', package_name: 'Basic Health Check', code_letter: 'B', price_inr: '999', test: 'CBC; FBS' },
    ];
  }
  const name = current ? `${ctx.event.code}-packages.csv` : 'packages-template.csv';
  return new NextResponse(toCsv(rows, [...PACKAGE_TEMPLATE_COLUMNS]), { headers: {
    'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'private, no-store' } });
}
