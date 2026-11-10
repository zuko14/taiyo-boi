import { NextResponse } from 'next/server';
import { getEventContext, type EventContext } from '@/lib/auth';
import { toCsv } from '@/lib/csv';
import { serviceClient } from '@/lib/supabase/server';

type Exporter = { perms: string[]; run: (ctx: EventContext) => Promise<Record<string, unknown>[]> };
const mask = (s: string | null | undefined) => (s ? `…${s.slice(-4)}` : '');

// Role-controlled exports. Never include sponsor rates/amounts or clinical report files.
const EXPORTS: Record<string, Exporter> = {
  participants: { perms: ['participant.view'], run: async (c) => ((await c.supabase.from('registration_overview')
    .select('registration_code, full_name, employee_id, mobile, classification, package_name, status, created_at, arrived_at, ed_done, ed_total, wi_done, wi_total, current_step, payment_states, reports_published')
    .eq('event_id', c.event.id).order('created_at')).data ?? []).map((r) => ({ ...r, mobile: mask(r.mobile) })) },
  station_workload: { perms: ['dashboard.view'], run: async (c) => (((await c.supabase.rpc('dashboard_overview', { p_event: c.event.id })).data as { stations: Record<string, unknown>[] })?.stations ?? []).map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'id'))) },
  test_completion: { perms: ['dashboard.view', 'sponsor.view'], run: async (c) => (await c.supabase.rpc('test_attendance', { p_event: c.event.id, p_source: 'package' })).data ?? [] },
  sponsor_reconciliation: { perms: ['sponsor.view'], run: async (c) => (await c.supabase.rpc('sponsor_summary', { p_event: c.event.id })).data ?? [] },
  walkin_pending: { perms: ['participant.view'], run: async (c) => ((await c.supabase.from('participant_tasks')
    .select('service_name, status, registrations!inner(registration_code, status, participants(full_name))').eq('event_id', c.event.id).eq('location', 'walk_in')
    .in('status', ['not_attended', 'awaiting_choice', 'checked_in', 'in_service']).eq('registrations.status', 'active')).data ?? [])
    .map((t) => { const r = t.registrations as unknown as { registration_code: string; participants: { full_name: string } }; return { registration_code: r.registration_code, name: r.participants.full_name, service: t.service_name, status: t.status }; }) },
  addon_sales: { perms: ['finance.view'], run: async (c) => ((await c.supabase.from('order_items')
    .select('test_code, test_name, unit_price_paise, tax_paise, quantity, created_at, registrations(registration_code), orders!inner(status, payment_intents(status))')
    .eq('event_id', c.event.id).eq('source', 'addon')).data ?? []).map((i) => {
      const o = i.orders as unknown as { status: string; payment_intents: { status: string }[] | { status: string } | null };
      const pi = Array.isArray(o.payment_intents) ? o.payment_intents[0] : o.payment_intents;
      return { registration_code: (i.registrations as unknown as { registration_code: string }).registration_code, test_code: i.test_code, test_name: i.test_name,
        quantity: i.quantity, unit_price_inr: i.unit_price_paise / 100, tax_inr: i.tax_paise / 100, order_status: o.status, payment_status: pi?.status ?? 'none', created_at: i.created_at };
    }) },
  payment_reconciliation: { perms: ['finance.view'], run: async (c) => ((await c.supabase.from('payment_transactions')
    .select('method, provider_ref, amount_paise, status, note, created_at, payment_intents(status, registrations(registration_code))').eq('event_id', c.event.id).order('created_at')).data ?? [])
    .map((t) => { const pi = t.payment_intents as unknown as { status: string; registrations: { registration_code: string } }; return { registration_code: pi.registrations.registration_code,
      method: t.method, reference: mask(t.provider_ref), amount_inr: t.amount_paise / 100, transaction_status: t.status, payment_status: pi.status, note: t.note, at: t.created_at }; }) },
  report_status: { perms: ['report.view'], run: async (c) => ((await c.supabase.from('reports')
    .select('status, version, accession_ref, uploaded_at, published_at, registrations(registration_code), order_items(test_name)').eq('event_id', c.event.id)).data ?? [])
    .map((r) => ({ registration_code: (r.registrations as unknown as { registration_code: string }).registration_code, test: (r.order_items as unknown as { test_name: string }).test_name,
      version: r.version, status: r.status, accession_ref: r.accession_ref, uploaded_at: r.uploaded_at, published_at: r.published_at })) },
};

export async function GET(_: Request, { params }: { params: Promise<{ eventId: string; kind: string }> }) {
  const { eventId, kind } = await params;
  const ctx = await getEventContext(eventId);
  const ex = EXPORTS[kind];
  if (!ex) return new NextResponse('Unknown export', { status: 404 });
  if (!ctx.can('export.run') || !ctx.can(...ex.perms)) return new NextResponse('Forbidden', { status: 403 });
  const rows = await ex.run(ctx);
  await serviceClient().from('audit_logs').insert({ event_id: eventId, actor_id: ctx.user.id, action: 'export.run', entity_type: 'export', entity_id: kind, meta: { rows: rows.length } });
  return new NextResponse(toCsv(rows), { headers: {
    'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'private, no-store',
    'Content-Disposition': `attachment; filename="${ctx.event.code}-${kind}-${new Date().toISOString().slice(0, 10)}.csv"` } });
}
