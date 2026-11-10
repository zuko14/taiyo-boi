'use client';
import { useActionState } from 'react';
import { signIn } from '../actions';

export function LoginForm() {
  const [state, action, pending] = useActionState(signIn, {});
  return (
    <form action={action}>
      {state.error ? <div className="alert alert-err" role="alert">{state.error}</div> : null}
      <div className="field"><label htmlFor="email">Staff email</label>
        <input id="email" name="email" type="email" autoComplete="username" required autoFocus /></div>
      <div className="field"><label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required /></div>
      <button className="btn btn-accent btn-block" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}
