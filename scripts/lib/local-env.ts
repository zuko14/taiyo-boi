// Local-only convenience: when Supabase env vars are not set, read the keys of the local
// Supabase CLI stack (`supabase status`) so nothing secret has to be written to disk.
import { execSync } from 'node:child_process';

export function loadLocalEnv(): void {
  if (process.env.APP_ENV === 'production') return;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const s = JSON.parse(execSync('supabase status -o json', { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= s.API_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= s.ANON_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY ??= s.SERVICE_ROLE_KEY;
  }
  process.env.APP_ENV ??= 'development';
  process.env.APP_URL ??= 'http://localhost:3000';
  process.env.OTP_HMAC_SECRET ??= 'local-development-only-otp-secret-000000';
  process.env.SMS_PROVIDER ??= 'console';
  process.env.SEED_PASSWORD ??= 'Local-Synthetic-Pass-2026';
}
