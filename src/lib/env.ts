import 'server-only';
import { z } from 'zod';

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  APP_URL: z.string().url(),
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  OTP_HMAC_SECRET: z.string().min(32),
  SMS_PROVIDER: z.enum(['none', 'console']).default('none'),
});

let cached: z.infer<typeof schema> | undefined;

/** Validated server environment. Throws with the names (never values) of missing variables. */
export function env() {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  if (parsed.data.APP_ENV === 'production' && parsed.data.SMS_PROVIDER === 'console') {
    throw new Error('SMS_PROVIDER=console is not allowed in production');
  }
  cached = parsed.data;
  return cached;
}
