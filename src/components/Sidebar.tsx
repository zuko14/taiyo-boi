'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Icon, KriyaMark, type IconName } from './Icons';

export interface NavItem { href: string; label: string; icon: IconName; group: string }

export function Sidebar({ items, eventName, eventStatus, userName, signOut }:
  { items: NavItem[]; eventName: string; eventStatus: string; userName: string; signOut: () => Promise<void> }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const groups = [...new Set(items.map((i) => i.group))];
  const active = (href: string) => path === href || (href.split('/').length > 3 && path.startsWith(href + '/'));
  return (
    <>
      <button className="hamburger no-print" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}><Icon name="list" lg /></button>
      <div className={`backdrop ${open ? 'show' : ''}`} onClick={() => setOpen(false)} />
      <aside className={`sidebar no-print ${open ? 'mobile-open' : ''}`} aria-label="Main navigation">
        <div className="sidebar-head">
          <div className="brand"><KriyaMark /><span>Kriya AI</span></div>
          <div className="event-chip"><strong>{eventName}</strong>Event status: {eventStatus}</div>
        </div>
        <nav className="nav" onClick={() => setOpen(false)}>
          {groups.map((g) => (
            <div key={g}>
              <div className="nav-group">{g}</div>
              {items.filter((i) => i.group === g).map((i) => (
                <Link key={i.href} href={i.href} className={`nav-link ${active(i.href) ? 'on' : ''}`} aria-current={active(i.href) ? 'page' : undefined}>
                  <Icon name={i.icon} />{i.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span>{userName}</span>
          <div className="row">
            <Link className="btn btn-ghost btn-sm" href="/select-event">Switch event</Link>
            <ThemeToggle />
            <form action={signOut}><button className="btn btn-ghost btn-sm" aria-label="Sign out"><Icon name="logout" /></button></form>
          </div>
        </div>
      </aside>
    </>
  );
}

export function ThemeToggle() {
  return (
    <button className="btn btn-ghost btn-sm" aria-label="Toggle light/dark theme" onClick={() => {
      const root = document.documentElement;
      const next = root.getAttribute('data-theme') === 'light' ? null : 'light';
      if (next) root.setAttribute('data-theme', next); else root.removeAttribute('data-theme');
      localStorage.setItem('kriya-theme', next || 'dark');
    }}><Icon name="sun" /></button>
  );
}
