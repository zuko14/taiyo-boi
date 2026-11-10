import Link from 'next/link';
import { KriyaMark } from '@/components/Icons';
import { StatusBadge } from '@/components/ui';
import { requireStaff } from '@/lib/auth';
import { signOut } from '../actions';

export default async function SelectEvent() {
  const { supabase, profile } = await requireStaff();
  const { data: events } = await supabase.from('events').select('id, code, name, status, venue').order('created_at', { ascending: false });
  const { data: roles } = await supabase.from('event_memberships').select('event_id, role_code').eq('user_id', profile.user_id).eq('active', true);
  return (
    <main className="login-screen">
      <div className="login-card" style={{ maxWidth: 560 }}>
        <div className="row" style={{ marginBottom: 18 }}><div className="brand"><KriyaMark /><span>Kriya AI</span></div><span className="spacer" />
          <form action={signOut}><button className="btn btn-ghost btn-sm">Sign out</button></form></div>
        <div className="login-title">Choose an event</div>
        <p className="muted small">Signed in as {profile.full_name}</p>
        <ul className="list" style={{ marginTop: 12 }}>
          {(events ?? []).map((e) => (
            <li key={e.id}>
              <div><Link href={`/e/${e.id}`} className="strong">{e.name}</Link>
                <div className="small muted">{e.code} · {(roles ?? []).filter((r) => r.event_id === e.id).map((r) => r.role_code.replace(/_/g, ' ')).join(', ') || 'platform admin'}</div></div>
              <StatusBadge status={e.status} />
            </li>
          ))}
          {!events?.length ? <li className="muted">You are not assigned to any event yet. Ask the event administrator.</li> : null}
        </ul>
        {profile.is_platform_admin ? <Link className="btn btn-ghost btn-block" style={{ marginTop: 16 }} href="/platform">Platform administration</Link> : null}
      </div>
    </main>
  );
}
