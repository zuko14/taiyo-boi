import { KriyaMark } from '@/components/Icons';
import { LoginForm } from './LoginForm';

export default function Login() {
  return (
    <main className="login-screen">
      <div className="login-card">
        <div className="login-mark"><KriyaMark /></div>
        <div className="login-title">Kriya AI · Health Camp Operations</div>
        <p className="muted small" style={{ margin: '6px 0 22px' }}>Staff sign-in. Accounts are created by the event administrator.</p>
        <LoginForm />
      </div>
    </main>
  );
}
