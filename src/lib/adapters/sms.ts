import 'server-only';
import { env } from '@/lib/env';

// Adapter boundary for OTP/notification delivery. No real provider is integrated yet:
// a provider must be added here with confirmed credentials and an end-to-end test.
export interface SmsAdapter { readonly name: string; sendOtp(mobile: string, code: string): Promise<void> }

const none: SmsAdapter = {
  name: 'none',
  async sendOtp() { throw new Error('OTP delivery is not configured for this event. Please contact the help desk.'); },
};

// Development only: prints the code to the server log. Refused when APP_ENV=production (see env.ts).
const consoleAdapter: SmsAdapter = {
  name: 'console',
  async sendOtp(mobile, code) { console.info(`[dev-sms] OTP for ******${mobile.slice(-4)}: ${code}`); },
};

export const smsAdapter = (): SmsAdapter => (env().SMS_PROVIDER === 'console' ? consoleAdapter : none);
