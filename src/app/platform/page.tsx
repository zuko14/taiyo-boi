import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SubmitButton } from '@/components/SubmitButton';
import { StatusBadge } from '@/components/ui';
import { deleteEvent } from '@/app/e/[eventId]/admin/actions';
import { requireStaff } from '@/lib/auth';
import { go, orBack, str, bool } from '@/lib/flash';

async function createEvent(fd: FormData) {
  'use server';
  const { supabase, profile } = await requireStaff();
  if (!profile.is_platform_admin) go('/platform', 'err', 'Platform admin only.');
  const id = await orBack('/platform', supabase.rpc('create_event', { p_code: str(fd, 'code'), p_name: str(fd, 'name'), p_timezone: str(fd, 'timezone') || 'Asia/Kolkata' }));
  if (bool(fd, 'template')) await orBack(`/e/${id}/admin/event`, supabase.rpc('apply_brochure_template', { p_event: id }));
  redirect(`/e/${id}/admin/event?ok=${encodeURIComponent('Event created')}`);
}

export default async function Platform() {
  const { supabase, profile } = await requireStaff();
  if (!profile.is_platform_admin) redirect('/select-event');
  const { data: events } = await supabase.from('events').select('id, code, name, status').order('created_at', { ascending: false });
  return (
    <main className="login-screen" style={{ gap: 20 }}>
      <div className="login-card" style={{ maxWidth: 520 }}>
        <div className="login-title">Create an event</div>
        <p className="muted small">Creates the event with default role permissions. Configure packages, stations and staff next.</p>
        <form action={createEvent} style={{ marginTop: 16 }}>
          <div className="field"><label htmlFor="code">Internal event code</label><input id="code" name="code" required pattern="[A-Za-z0-9\-]{2,30}" placeholder="BOI-2026-MUM" /></div>
          <div className="field"><label htmlFor="name">Event name</label><input id="name" name="name" required /></div>
          <div className="field"><label htmlFor="timezone">Timezone</label><input id="timezone" name="timezone" defaultValue="Asia/Kolkata" /></div>
          <label className="check"><input type="checkbox" name="template" defaultChecked /> Load the Bank of India brochure template (fixed Female/Male packages, editable)</label>
          <p className="small muted">Leave unticked for any other camp: you then create your own packages, tests and prices.</p>
          <div className="row" style={{ marginTop: 16 }}><SubmitButton>Create event</SubmitButton><Link href="/select-event" className="btn btn-ghost">Back</Link></div>
        </form>
      </div>
      <div className="login-card" style={{ maxWidth: 520 }}>
        <div className="login-title">Delete an event</div>
        <p className="muted small">Permanently removes the event with all participants, orders, payments, reports and configuration. This cannot be undone. A live event must be paused or closed first. To clear a pilot run but keep the setup, use <strong>Reset event</strong> on the event&apos;s Event &amp; readiness page instead.</p>
        <ul className="list" style={{ marginTop: 12 }}>
          {(events ?? []).map((e) => (
            <li key={e.id} style={{ display: 'block' }}>
              <details>
                <summary className="row-between" style={{ cursor: 'pointer' }}><span><span className="strong">{e.name}</span> <span className="small muted mono">{e.code}</span></span><StatusBadge status={e.status} /></summary>
                <form action={deleteEvent} style={{ marginTop: 10 }}>
                  <input type="hidden" name="event_id" value={e.id} /><input type="hidden" name="back" value="/platform" />
                  <div className="field"><label htmlFor={`c-${e.id}`}>Type <span className="mono">{e.code}</span> to confirm</label>
                    <input id={`c-${e.id}`} name="confirm" required autoComplete="off" /></div>
                  <SubmitButton className="btn btn-red btn-sm" confirm={`Permanently delete ${e.code}? This cannot be undone.`}>Delete event permanently</SubmitButton>
                </form>
              </details>
            </li>))}
          {!events?.length ? <li className="muted">No events.</li> : null}
        </ul>
      </div>
    </main>
  );
}
