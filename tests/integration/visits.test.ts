import { beforeAll, describe, expect, it } from 'vitest';
import { buildEvent, type Fixture } from '../../scripts/lib/fixture.ts';
import { db, must, newCode } from './helpers.ts';

let fx: Fixture; let ev: string;
const visit = (name: string, loc = 'event_day') => must<string>(fx.platform.client.rpc('ensure_service', { p_event: ev, p_name: name, p_location: loc }));
const errors = async () => (await must<{ level: string; message: string }[]>(fx.platform.client.rpc('validate_event', { p_event: ev }))).filter((c) => c.level === 'error').map((c) => c.message);
const linkOf = async (code: string) => (await must<{ service_id: string }>(db().from('workflow_service_tests').select('service_id, test_catalog!inner(code)').eq('test_catalog.code', code).eq('event_id', ev).single())).service_id;

beforeAll(async () => {
  fx = await buildEvent({ code: newCode('VIS'), live: false });
  ev = await must<string>(fx.platform.client.rpc('create_event', { p_code: newCode('VS'), p_name: 'Visits camp' }));
});

describe('one name per visit', () => {
  it('usg / Ultrasound (USG) / ultra sound / sonography are one visit; same for echo, x-ray, ecg', async () => {
    const usg = await visit('usg');
    for (const n of ['Ultrasound (USG)', 'ultra sound', 'Sonography']) expect(await visit(n)).toBe(usg);
    const echo = await visit('2D Echo');
    expect(await visit('Echocardiography')).toBe(echo);
    expect(await visit('XRAY')).toBe(await visit('X-Ray'));
    expect(await visit('EKG')).toBe(await visit('ecg'));
    expect(new Set([usg, echo]).size).toBe(2);
  });
});

describe('merging and custom rooms', () => {
  it('merging a stray visit into the one a station does clears the readiness error', async () => {
    const a = fx.platform.client;
    const stray = await visit('Abdomen scan'); const main = await visit('Ultrasound (USG)');
    await must(a.rpc('import_catalog', { p_event: ev, p_rows: [{ code: 'USG-ABD', name: 'USG Abdomen', category: '', price_paise: null, location: 'event_day', service_code: 'ABDOMEN-SCAN', lab_order_code: '', instructions: '' }] }));
    const st = await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'U1', name: 'Imaging', kind: 'station' }).select('id').single());
    await must(a.from('station_capabilities').insert({ event_id: ev, station_id: st.id, service_id: main }));
    expect(await errors()).toContain('Event-day service "Abdomen scan" has no compatible diagnostic station');
    await must(a.rpc('merge_service', { p_from: stray, p_into: main, p_reason: 'duplicate' }));
    expect(await linkOf('USG-ABD')).toBe(main);
    expect(await errors()).not.toContain('Event-day service "Abdomen scan" has no compatible diagnostic station');
    expect((await must<{ active: boolean }>(db().from('workflow_services').select('active').eq('id', stray).single())).active).toBe(false);
  });

  it('a custom room picks its tests: separate stops by default, or one combined stop', async () => {
    const a = fx.platform.client;
    const ecg = await visit('ECG');
    await must(a.rpc('import_catalog', { p_event: ev, p_rows: [
      { code: 'ECG', name: 'ECG', category: '', price_paise: null, location: 'event_day', service_code: 'ECG', lab_order_code: '', instructions: '' },
      { code: 'ECHO', name: '2D Echo', category: '', price_paise: null, location: 'event_day', service_code: '2D-ECHO', lab_order_code: '', instructions: '' }] }));
    const ids = (await must<{ id: string }[]>(db().from('test_catalog').select('id').eq('event_id', ev).in('code', ['ECG', 'ECHO']))).map((t) => t.id);
    const room = await must<{ id: string }>(a.from('stations').insert({ event_id: ev, code: 'C1', name: 'Cardiac room', kind: 'station' }).select('id').single());
    const separate = await must<string[]>(a.rpc('station_link_tests', { p_station: room.id, p_test_ids: ids, p_one_stop: false }));
    expect(new Set(separate)).toEqual(new Set([ecg, await visit('2D Echo')]));               // each keeps its own visit
    const combined = await must<string[]>(a.rpc('station_link_tests', { p_station: room.id, p_test_ids: ids, p_one_stop: true }));
    expect(combined).toHaveLength(1);
    const own = await must<{ code: string; name: string }>(db().from('workflow_services').select('code, name').eq('id', combined[0]).single());
    expect(own).toEqual({ code: 'ROOM-C1', name: 'Cardiac room' });
    expect(await linkOf('ECG')).toBe(combined[0]);
    expect(await linkOf('ECHO')).toBe(combined[0]);
    // walk-in tests cannot be put on an event-day station
    await must(a.rpc('import_catalog', { p_event: ev, p_rows: [{ code: 'MAMMO', name: 'Mammography', category: '', price_paise: null, location: 'walk_in', service_code: 'MAMMO', lab_order_code: '', instructions: '' }] }));
    const mammo = (await must<{ id: string }>(db().from('test_catalog').select('id').eq('event_id', ev).eq('code', 'MAMMO').single())).id;
    const { error } = await a.rpc('station_link_tests', { p_station: room.id, p_test_ids: [mammo], p_one_stop: false });
    expect(error?.message).toMatch(/walk-in centre — not at this station/);
  });
});
