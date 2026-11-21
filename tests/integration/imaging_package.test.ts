import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildEvent, type Fixture } from '../../scripts/lib/fixture.ts';
import { db, must, newCode } from './helpers.ts';

// "Taiyo Aarush Executive Plus"-style package: blood tests + ECG + Ultrasound + 2D Echo + Chest X-Ray,
// with one imaging room doing both Ultrasound and 2D Echo.
let fx: Fixture; let ev: string; let reg: string; const st: Record<string, string> = {};
beforeAll(async () => {
  fx = await buildEvent({ code: newCode('IMG') });
  const a = fx.platform.client;
  ev = await must<string>(a.rpc('create_event', { p_code: newCode('AAR'), p_name: 'Aarush camp' }));
  await must(a.from('events').update({ settings: { require_consent: true, payment_maker_checker: false, payment_methods: ['cash'], package_mode: 'custom', payment_model: 'patient_pays' } }).eq('id', ev));
  const visit = (name: string) => must<string>(a.rpc('ensure_service', { p_event: ev, p_name: name, p_location: 'event_day' }));
  const v = { blood: await visit('Blood sample collection'), ecg: await visit('ECG'), usg: await visit('Ultrasound (USG)'), echo: await visit('2D Echo'), xray: await visit('X-Ray') };
  const codes = await must<{ code: string }[]>(db().from('workflow_services').select('code').eq('event_id', ev).order('code'));
  expect(codes.map((c) => c.code)).toEqual(['2D-ECHO', 'ECG', 'SAMPLE', 'USG', 'X-RAY']);
  await must(a.rpc('import_catalog', { p_event: ev, p_rows: [
    ['FBS', 'SAMPLE'], ['CBC', 'SAMPLE'], ['LIPID', 'SAMPLE'], ['ECG', 'ECG'], ['USG', 'USG'], ['ECHO-2D', '2D-ECHO'], ['XRAY-CHEST', 'X-RAY'],
  ].map(([code, svc]) => ({ code, name: code, category: '', price_paise: 10000, location: 'event_day', service_code: svc, lab_order_code: '', instructions: '' })) }));
  const pkg = (await must<{ id: string }>(db().from('packages').insert({ event_id: ev, classification: 'aarush', code: 'AARUSH', name: 'Aarush Executive Plus', code_letter: 'A', price_paise: 449900 }).select('id').single())).id;
  const tests = await must<{ id: string }[]>(db().from('test_catalog').select('id').eq('event_id', ev));
  await must(db().from('package_tests').insert(tests.map((t) => ({ event_id: ev, package_id: pkg, test_id: t.id }))));
  reg = (await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'R1', name: 'Registration', kind: 'registration_counter' }).select('id').single())).id;
  for (const [code, caps] of [['B1', [v.blood]], ['E1', [v.ecg]], ['U1', [v.usg, v.echo]], ['X1', [v.xray]]] as const) {
    st[code] = (await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code, name: code, kind: 'station' }).select('id').single())).id;
    for (const c of caps) await must(a.from('station_capabilities').insert({ event_id: ev, station_id: st[code], service_id: c }));
  }
  for (const [role, u] of [['registration_staff', fx.users.registration_staff], ['station_staff', fx.users.station_staff]] as const)
    await must(a.from('event_memberships').insert({ event_id: ev, user_id: u.id, role_code: role, created_by: fx.platform.id }));
  const start = new Date(Date.now() - 60_000).toISOString(); const end = new Date(Date.now() + 3600_000).toISOString();
  await must(a.rpc('assign_staff', { p_station: reg, p_user: fx.users.registration_staff.id, p_start: start, p_end: end }));
  await must(a.rpc('station_set_status', { p_station: reg, p_status: 'open', p_reason: null }));
  for (const s of Object.values(st)) await must(a.rpc('assign_staff', { p_station: s, p_user: fx.users.station_staff.id, p_start: start, p_end: end }));
  await must(a.rpc('set_event_status', { p_event: ev, p_status: 'live', p_reason: null }));
});

describe('package with imaging tests', () => {
  it('blood tests share one stop; ECG, X-Ray and the ultrasound room are their own stops; everything gets done', async () => {
    const r = await must<{ registration_id: string; payment_intent_id: string }>(fx.users.registration_staff.client.rpc('register_participant', {
      p_counter: reg, p_idempotency_key: randomUUID(), p_classification: 'aarush', p_full_name: 'Synthetic Resident', p_consent: true }));
    const tasks = await must<{ service_name: string }[]>(db().from('participant_tasks').select('service_name').eq('registration_id', r.registration_id));
    expect(tasks.map((t) => t.service_name).sort()).toEqual(['2D Echo', 'Blood sample collection', 'ECG', 'Ultrasound (USG)', 'X-Ray']);
    await must(fx.platform.client.rpc('verify_payment', { p_intent: r.payment_intent_id, p_method: 'cash', p_provider_ref: null, p_amount_paise: 449900 }));
    const visited: string[] = [];
    for (let i = 0; i < 5; i++) {
      const q = (await must<{ task_id: string; station_id: string; state: string }[]>(db().from('queue_assignments').select('task_id, station_id, state')
        .eq('registration_id', r.registration_id).in('state', ['queued', 'called', 'in_service'])))[0];
      expect(q.state).toBe('called');
      visited.push(Object.entries(st).find(([, id]) => id === q.station_id)![0]);
      await must(fx.users.station_staff.client.rpc('task_action', { p_task: q.task_id, p_action: 'start', p_station: q.station_id, p_reason: null }));
      await must(fx.users.station_staff.client.rpc('task_action', { p_task: q.task_id, p_action: 'complete', p_station: q.station_id, p_reason: null }));
    }
    expect(visited.sort()).toEqual(['B1', 'E1', 'U1', 'U1', 'X1']);              // the ultrasound room did both USG and 2D Echo
    const done = await must<{ status: string }[]>(db().from('participant_tasks').select('status').eq('registration_id', r.registration_id));
    expect(done.every((t) => t.status === 'completed')).toBe(true);
    expect(await must<unknown[]>(db().from('task_attendance_events').select('id').eq('registration_id', r.registration_id).eq('kind', 'completed'))).toHaveLength(7);
  });
});
