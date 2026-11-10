import type { ReactNode } from 'react';
import { Sidebar, type NavItem } from '@/components/Sidebar';
import { getEventContext } from '@/lib/auth';
import { statusLabel } from '@/lib/format';
import { signOut } from '@/app/actions';

const NAV: (Omit<NavItem, 'href'> & { path: string; perms: string[] })[] = [
  { group: 'Operations', path: '', label: 'Dashboard', icon: 'activity', perms: ['dashboard.view'] },
  { group: 'Operations', path: '/register', label: 'Registration desk', icon: 'plus', perms: ['registration.create'] },
  { group: 'Operations', path: '/participants', label: 'Participants', icon: 'users', perms: ['participant.view'] },
  { group: 'Operations', path: '/addons', label: 'Add-on desk', icon: 'card', perms: ['addon.create'] },
  { group: 'Operations', path: '/payments', label: 'Payments', icon: 'wallet', perms: ['payment.verify', 'payment.view'] },
  { group: 'Operations', path: '/station', label: 'My station', icon: 'zap', perms: ['task.perform'] },
  { group: 'Operations', path: '/queues', label: 'Queue control', icon: 'shuffle', perms: ['queue.override', 'station.operate'] },
  { group: 'Operations', path: '/walkin', label: 'Walk-in centre', icon: 'building', perms: ['walkin.checkin', 'walkin.perform'] },
  { group: 'Operations', path: '/reports', label: 'Reports', icon: 'file', perms: ['report.view'] },
  { group: 'Insights', path: '/finance', label: 'Add-on revenue', icon: 'trending-up', perms: ['finance.view'] },
  { group: 'Insights', path: '/attendance', label: 'Attendance counts', icon: 'list', perms: ['sponsor.view', 'dashboard.view'] },
  { group: 'Insights', path: '/exports', label: 'Exports', icon: 'download', perms: ['export.run'] },
  { group: 'Insights', path: '/audit', label: 'Audit log', icon: 'eye', perms: ['audit.view'] },
  { group: 'Setup', path: '/admin/event', label: 'Event & readiness', icon: 'settings', perms: ['event.configure'] },
  { group: 'Setup', path: '/admin/catalog', label: 'Test catalogue', icon: 'list', perms: ['catalogue.view'] },
  { group: 'Setup', path: '/admin/packages', label: 'Packages & services', icon: 'card', perms: ['package.view'] },
  { group: 'Setup', path: '/admin/prices', label: 'Add-on prices', icon: 'wallet', perms: ['addon.price.edit'] },
  { group: 'Setup', path: '/admin/stations', label: 'Stations & counters', icon: 'building', perms: ['station.configure', 'station.mapping.edit'] },
  { group: 'Setup', path: '/admin/staff', label: 'Staff & shifts', icon: 'users', perms: ['staff.manage', 'shift.assign'] },
  { group: 'Setup', path: '/admin/permissions', label: 'Permissions', icon: 'lock', perms: ['permissions.manage'] },
];

export default async function EventLayout({ children, params }: { children: ReactNode; params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const items = NAV.filter((n) => ctx.can(...n.perms)).map((n) => ({ group: n.group, label: n.label, icon: n.icon, href: `/e/${eventId}${n.path}` }));
  return (
    <div className="app">
      <Sidebar items={items} eventName={ctx.event.name} eventStatus={statusLabel(ctx.event.status)} userName={ctx.profile.full_name} signOut={signOut} />
      <main className="main"><div className="main-inner">{children}</div></main>
    </div>
  );
}
