// `npm run load-test` — LOCAL synthetic load: N registrations from parallel counters, then
// concurrent station completions. Reports latency and checks the hard invariants.
import { randomUUID } from 'node:crypto';
import { loadLocalEnv } from './lib/local-env.ts';
import { buildEvent, must, serviceClient } from './lib/fixture.ts';

loadLocalEnv();
if (process.env.APP_ENV === 'production') throw new Error('Refusing to load-test production');
const N = Number(process.argv[2] ?? 500);
const CONC = Number(process.argv[3] ?? 10);

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}
const pct = (a: number[], p: number) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

const fx = await buildEvent({ code: `LOAD-${randomUUID().slice(0, 4).toUpperCase()}` });
const staff = [fx.users.registration_staff.client, fx.users.registration_supervisor.client];
const lat: number[] = []; let errors = 0;
const ids: string[] = [];
let t0 = Date.now();
await pool(Array.from({ length: N }, (_, i) => i), CONC, async (i) => {
  const s = Date.now();
  const { data, error } = await staff[i % 2].rpc('register_participant', {
    p_counter: fx.stations[i % 2 ? 'REG-2' : 'REG-1'], p_idempotency_key: randomUUID(),
    p_classification: i % 2 ? 'male' : 'female', p_full_name: `Load ${i}`, p_consent: true });
  lat.push(Date.now() - s);
  if (error) errors++; else ids.push((data as { registration_id: string }).registration_id);
});
const regSecs = (Date.now() - t0) / 1000;
console.log(`registrations: ${ids.length}/${N} ok, ${errors} errors, ${regSecs.toFixed(1)}s, p50 ${pct(lat, 0.5)}ms p95 ${pct(lat, 0.95)}ms max ${Math.max(...lat)}ms`);

// two rounds of start+complete for every participant's current assignment, in parallel
const st = fx.users.station_staff.client; const svc = serviceClient();
const lat2: number[] = []; let errors2 = 0;
t0 = Date.now();
for (let round = 0; round < 2; round++) {
  const { data: qa } = await svc.from('queue_assignments').select('task_id, station_id').eq('event_id', fx.eventId).eq('state', 'queued');
  await pool(qa ?? [], CONC, async (a) => {
    for (const action of ['start', 'complete']) {
      const s = Date.now();
      const { error } = await st.rpc('task_action', { p_task: a.task_id, p_action: action, p_station: a.station_id });
      lat2.push(Date.now() - s);
      if (error) errors2++;
    }
  });
}
console.log(`station actions: ${lat2.length} calls, ${errors2} errors, ${((Date.now() - t0) / 1000).toFixed(1)}s, p50 ${pct(lat2, 0.5)}ms p95 ${pct(lat2, 0.95)}ms`);

// invariants
const regs = await must<{ registration_code: string }[]>(svc.from('registrations').select('registration_code').eq('event_id', fx.eventId).limit(10000));
const dupCodes = regs.length - new Set(regs.map((r) => r.registration_code)).size;
const qa = await must<{ registration_id: string; state: string; station_id: string; participant_tasks: { service_id: string; location: string } }[]>(
  svc.from('queue_assignments').select('registration_id, state, station_id, participant_tasks(service_id, location)').eq('event_id', fx.eventId).limit(20000));
const caps = new Set((await must<{ station_id: string; service_id: string }[]>(svc.from('station_capabilities').select('station_id, service_id').eq('event_id', fx.eventId))).map((c) => `${c.station_id}:${c.service_id}`));
const incompatible = qa.filter((q) => q.participant_tasks.location !== 'event_day' || !caps.has(`${q.station_id}:${q.participant_tasks.service_id}`)).length;
const active = new Map<string, number>();
for (const q of qa) if (['queued', 'called', 'in_service'].includes(q.state)) active.set(q.registration_id, (active.get(q.registration_id) ?? 0) + 1);
const multi = [...active.values()].filter((n) => n > 1).length;
const att = await must<{ order_item_id: string; kind: string }[]>(svc.from('task_attendance_events').select('order_item_id, kind').eq('event_id', fx.eventId).limit(50000));
const dupAtt = att.length - new Set(att.map((a) => `${a.order_item_id}:${a.kind}`)).size;
console.log(`invariants: duplicate codes ${dupCodes}, incompatible assignments ${incompatible}, participants with >1 active assignment ${multi}, duplicate attendance rows ${dupAtt}`);
process.exit(dupCodes || incompatible || multi || dupAtt ? 1 : 0);
