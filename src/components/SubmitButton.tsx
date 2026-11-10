'use client';
import { useFormStatus } from 'react-dom';
import type { ReactNode } from 'react';

/** Disables while the server action is in flight; server idempotency is the real safeguard. */
export function SubmitButton({ children, className = 'btn btn-accent', confirm, name, value, disabled }:
  { children: ReactNode; className?: string; confirm?: string; name?: string; value?: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending || disabled} name={name} value={value} aria-busy={pending}
      onClick={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}>
      {pending ? 'Working…' : children}
    </button>
  );
}
