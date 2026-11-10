import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SubmitButton } from '@/components/SubmitButton';
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
  const { profile } = await requireStaff();
  if (!profile.is_platform_admin) redirect('/select-event');
  return (
    <main className="login-screen">
      <div className="login-card" style={{ maxWidth: 520 }}>
        <div className="login-title">Create an event</div>
        <p className="muted small">Creates the event with default role permissions. Configure packages, stations and staff next.</p>
        <form action={createEvent} style={{ marginTop: 16 }}>
          <div className="field"><label htmlFor="code">Internal event code</label><input id="code" name="code" required pattern="[A-Za-z0-9-]{2,30}" placeholder="BOI-2026-MUM" /></div>
          <div className="field"><label htmlFor="name">Event name</label><input id="name" name="name" required /></div>
          <div className="field"><label htmlFor="timezone">Timezone</label><input id="timezone" name="timezone" defaultValue="Asia/Kolkata" /></div>
          <label className="check"><input type="checkbox" name="template" defaultChecked /> Load the client brochure package template (editable)</label>
          <div className="row" style={{ marginTop: 16 }}><SubmitButton>Create event</SubmitButton><Link href="/select-event" className="btn btn-ghost">Back</Link></div>
        </form>
      </div>
    </main>
  );
}
