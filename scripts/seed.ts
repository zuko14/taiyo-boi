// `npm run seed` — creates a synthetic demo event on the LOCAL stack. Synthetic data only.
// Prices below are DEMO values, not Lab Partner prices.
import { randomUUID } from 'node:crypto';
import { loadLocalEnv } from './lib/local-env.ts';
import { buildEvent, must } from './lib/fixture.ts';

loadLocalEnv();
if (process.env.APP_ENV === 'production') throw new Error('Refusing to seed synthetic data in production');

const code = process.argv[2] ?? 'BOI-DEMO';
const fx = await buildEvent({ code, name: 'BOI Employee Health Camp (synthetic demo)', emailDomain: 'demo.example.test', live: false });
const admin = fx.users.event_admin.client;

for (const [test, price] of [['XRAY', 50000], ['TFT', 30000], ['PSA', 40000], ['CA-125', 60000]] as const) {
  await must(admin.from('test_catalog').update({ addon_available: true }).eq('id', fx.tests[test]));
  await must(admin.from('addon_prices').insert({ event_id: fx.eventId, test_id: fx.tests[test], price_paise: price }));
}

await must(admin.rpc('set_event_status', { p_event: fx.eventId, p_status: 'live', p_reason: null }));

const reg = fx.users.registration_staff.client;
const names = ['Asha Verma', 'Ravi Kumar', 'Meena Iyer', 'Sanjay Rao', 'Priya Nair', 'Arjun Das'];
for (const [i, name] of names.entries()) {
  await must(reg.rpc('register_participant', {
    p_counter: fx.stations[i % 2 ? 'REG-2' : 'REG-1'], p_idempotency_key: randomUUID(),
    p_classification: i % 2 ? 'male' : 'female', p_full_name: name, p_age: 30 + i,
    p_employee_id: `SYN${1000 + i}`, p_mobile: `90000000${10 + i}`, p_consent: true,
  }));
}

console.log(`Seeded event ${code} (${fx.eventId}). Staff logins (password = SEED_PASSWORD):`);
console.log(`  platform@demo.example.test`);
for (const [role, u] of Object.entries(fx.users)) console.log(`  ${u.email.padEnd(44)} ${role}`);
