import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildEvent, type Fixture } from '../../scripts/lib/fixture.ts';
import { db, must, newCode, register, rpcError, sha256, tasksOf } from './helpers.ts';

let fx: Fixture;
let other: Fixture;
beforeAll(async () => {
  [fx, other] = await Promise.all([buildEvent({ code: newCode('WRS') }), buildEvent({ code: newCode('OTH') })]);
});

const walkin = (task: string, action: string, reason: string | null = null) =>
  fx.users.walkin_staff.client.rpc('task_action', { p_task: task, p_action: action, p_station: fx.stations['WI-1'], p_reason: reason });

describe('walk-in centre', () => {
  it('check-in is not completion; completion records attendance only for that test', async () => {
    const r = await register(fx, 'male');
    const t = (await tasksOf(r.registration_id)).find((x) => x.location === 'walk_in')!;
    await must(walkin(t.id, 'checkin'));
    const att = await must<{ kind: string }[]>(db().from('task_attendance_events').select('kind').eq('task_id', t.id));
    expect(att.map((a) => a.kind)).toEqual(['appeared']);
    expect(await rpcError(walkin(t.id, 'complete'))).toMatch(/illegal_transition/);
    await must(walkin(t.id, 'start'));
    await must(walkin(t.id, 'complete'));
    const done = await must<{ kind: string }[]>(db().from('task_attendance_events').select('kind').eq('task_id', t.id).eq('kind', 'completed'));
    expect(done).toHaveLength(1);
    const qa = await must<unknown[]>(db().from('queue_assignments').select('id').eq('task_id', t.id));
    expect(qa).toHaveLength(0);       // walk-in work never enters the event-day queue
  });

  it('female USG choice: one option must be selected before check-in', async () => {
    const r = await register(fx, 'female');
    const t = (await tasksOf(r.registration_id)).find((x) => x.location === 'walk_in')!;
    expect(t.status).toBe('awaiting_choice');
    expect(await rpcError(walkin(t.id, 'checkin'))).toMatch(/illegal_transition/);
    const both = [fx.tests['USG-THYROID'], fx.tests['USG-BREAST']];
    expect(await rpcError(fx.users.walkin_staff.client.rpc('select_choice',
      { p_reg: r.registration_id, p_group: t.choice_group_id, p_test_ids: both }))).toMatch(/exactly one/);
    await must(fx.users.walkin_staff.client.rpc('select_choice',
      { p_reg: r.registration_id, p_group: t.choice_group_id, p_test_ids: [fx.tests['USG-BREAST']] }));
    const lines = await must<{ test_code: string }[]>(db().from('order_items').select('test_code')
      .eq('registration_id', r.registration_id).eq('location', 'walk_in').eq('status', 'active'));
    expect(lines.map((l) => l.test_code)).toEqual(['USG-BREAST']);
    await must(walkin(t.id, 'checkin'));
  });

  it('a diagnostic station cannot be used for walk-in work', async () => {
    const r = await register(fx, 'male');
    const t = (await tasksOf(r.registration_id)).find((x) => x.location === 'walk_in')!;
    expect(await rpcError(fx.users.station_staff.client.rpc('task_action',
      { p_task: t.id, p_action: 'checkin', p_station: fx.stations['ECG-1'] }))).toMatch(/permission_denied|invalid_station/);
  });
});

describe('reports', () => {
  async function upload(regId: string, accession: string | null = null) {
    const item = (await must<{ id: string }[]>(db().from('order_items').select('id').eq('registration_id', regId).limit(1)))[0];
    const rp = await must<{ report_id: string; status: string }>(fx.users.report_manager.client.rpc('report_create', {
      p_order_item: item.id, p_title: 'Report', p_file_name: 'r.pdf', p_mime: 'application/pdf', p_size: 1000,
      p_checksum: sha256('x' + Math.random()), p_accession: accession }));
    await must(fx.users.report_manager.client.rpc('report_action', { p_report: rp.report_id, p_action: 'uploaded' }));
    return { ...rp, itemId: item.id };
  }

  it('only validated reports publish, the validator must differ from the uploader, and only published ones reach the portal', async () => {
    const r = await register(fx, 'female', { p_mobile: '9000000001' });
    const rp = await upload(r.registration_id);
    const mgr = fx.users.report_manager.client;
    expect(await rpcError(mgr.rpc('report_action', { p_report: rp.report_id, p_action: 'publish' }))).toMatch(/illegal_transition/);
    expect(await rpcError(mgr.rpc('report_action', { p_report: rp.report_id, p_action: 'validate' }))).toMatch(/maker_checker/);
    await must(fx.users.event_admin.client.rpc('report_action', { p_report: rp.report_id, p_action: 'validate' }));

    const token = randomBytes(32).toString('base64url');
    const s0 = randomBytes(16).toString('hex'); const s1 = randomBytes(16).toString('hex');
    await must(fx.users.registration_staff.client.rpc('issue_tag', { p_reg: r.registration_id, p_token_hash: sha256(token) }));
    await must(db().rpc('portal_otp_request', { p_token_hash: sha256(token), p_code_hash: sha256('123456') }));
    expect(await must<boolean>(db().rpc('portal_otp_verify', { p_token_hash: sha256(token), p_code_hash: sha256('000000'), p_session_hash: sha256(s0) }))).toBe(false);
    expect(await must<boolean>(db().rpc('portal_otp_verify', { p_token_hash: sha256(token), p_code_hash: sha256('123456'), p_session_hash: sha256(s1) }))).toBe(true);
    const list = () => must<unknown[]>(db().rpc('portal_reports', { p_token_hash: sha256(token), p_session_hash: sha256(s1) }));
    expect(await list()).toHaveLength(0);
    await must(mgr.rpc('report_action', { p_report: rp.report_id, p_action: 'publish' }));
    expect(await list()).toHaveLength(1);
    await must(mgr.rpc('report_action', { p_report: rp.report_id, p_action: 'withdraw', p_reason: 'wrong file' }));
    expect(await list()).toHaveLength(0);
    // a different session hash (no OTP) gets nothing
    const { error } = await db().rpc('portal_reports', { p_token_hash: sha256(token), p_session_hash: sha256('forged') });
    expect(error?.message).toMatch(/verification_required/);
  });

  it('accession mismatch holds the report for review and blocks publication', async () => {
    const r = await register(fx, 'male');
    const item = (await must<{ id: string }[]>(db().from('order_items').select('id').eq('registration_id', r.registration_id).limit(1)))[0];
    await must(db().from('order_items').update({ external_accession: 'ACC-1' }).eq('id', item.id));
    const rp = await must<{ report_id: string; status: string }>(fx.users.report_manager.client.rpc('report_create', {
      p_order_item: item.id, p_title: 'Report', p_file_name: 'r.pdf', p_mime: 'application/pdf', p_size: 10,
      p_checksum: sha256('y'), p_accession: 'ACC-999' }));
    expect(rp.status).toBe('requires_review');
    expect(await rpcError(fx.users.event_admin.client.rpc('report_action', { p_report: rp.report_id, p_action: 'validate' })))
      .toMatch(/illegal_transition/);
  });
});

describe('tags and portal tokens', () => {
  it('reprint rotates the token: the old QR stops working; revoke kills the current one', async () => {
    const r = await register(fx, 'female');
    const t1 = randomBytes(32).toString('base64url');
    const t2 = randomBytes(32).toString('base64url');
    await must(fx.users.registration_staff.client.rpc('issue_tag', { p_reg: r.registration_id, p_token_hash: sha256(t1) }));
    expect(await must(db().rpc('portal_view', { p_token_hash: sha256(t1) }))).not.toBeNull();
    expect(await rpcError(fx.users.registration_staff.client.rpc('issue_tag',
      { p_reg: r.registration_id, p_token_hash: sha256(t2), p_reason: 'damaged' }))).toMatch(/permission_denied/);
    await must(fx.users.registration_supervisor.client.rpc('issue_tag', { p_reg: r.registration_id, p_token_hash: sha256(t2), p_reason: 'damaged' }));
    expect(await must(db().rpc('portal_view', { p_token_hash: sha256(t1) }))).toBeNull();
    const view = await must<{ registration: { code: string }; tasks: unknown[] }>(db().rpc('portal_view', { p_token_hash: sha256(t2) }));
    expect(view.registration.code).toBe(r.registration_code);
    expect(JSON.stringify(view)).not.toMatch(/2999|1999|amount_paise":(299900|199900)/);
    await must(fx.users.registration_supervisor.client.rpc('revoke_tag', { p_reg: r.registration_id, p_reason: 'lost' }));
    expect(await must(db().rpc('portal_view', { p_token_hash: sha256(t2) }))).toBeNull();
    const prints = await must<unknown[]>(db().from('tag_prints').select('id').eq('registration_id', r.registration_id));
    expect(prints).toHaveLength(2);
  });

  it('portal functions are not callable by staff sessions', async () => {
    const { error } = await fx.users.event_admin.client.rpc('portal_view', { p_token_hash: sha256('x') });
    expect(error).not.toBeNull();
  });
});

describe('isolation and audit', () => {
  it('staff of one event cannot read or act on another event', async () => {
    const r = await register(fx, 'female');
    const { data } = await other.users.event_admin.client.from('registrations').select('id').eq('event_id', fx.eventId);
    expect(data ?? []).toHaveLength(0);
    expect(await rpcError(other.users.registration_staff.client.rpc('register_participant', {
      p_counter: fx.stations['REG-1'], p_idempotency_key: 'k', p_classification: 'female', p_full_name: 'x', p_consent: true })))
      .toMatch(/not_on_duty|permission_denied/);
    const t = (await tasksOf(r.registration_id))[0];
    expect(await rpcError(other.users.station_supervisor.client.rpc('task_action',
      { p_task: t.id, p_action: 'skip', p_reason: 'x' }))).toMatch(/permission_denied/);
    expect(await rpcError(other.users.event_admin.client.rpc('dashboard_overview', { p_event: fx.eventId }))).toMatch(/permission_denied/);
  });

  it('the sponsor viewer sees counts only, never identities or reports', async () => {
    const sp = fx.users.sponsor_viewer.client;
    expect((await sp.from('participants').select('id')).data ?? []).toHaveLength(0);
    expect((await sp.from('reports').select('id')).data ?? []).toHaveLength(0);
    const counts = await must<{ expected: number }[]>(sp.rpc('test_attendance', { p_event: fx.eventId }));
    expect(counts.length).toBeGreaterThan(0);
    const summary = await must<{ classification: string; registered: number }[]>(sp.rpc('sponsor_summary', { p_event: fx.eventId }));
    expect(summary.map((s) => s.classification)).toEqual(['female', 'male']);
    expect(JSON.stringify(summary)).not.toMatch(/paise|rate|amount/);
  });

  it('station staff cannot escalate their own permissions', async () => {
    const st = fx.users.station_staff;
    const { error } = await st.client.from('event_memberships').insert({ event_id: fx.eventId, user_id: st.id, role_code: 'event_admin' });
    expect(error).not.toBeNull();
    const { error: e2 } = await fx.users.station_supervisor.client.from('event_memberships')
      .insert({ event_id: fx.eventId, user_id: fx.users.station_supervisor.id, role_code: 'cashier' });
    expect(e2).not.toBeNull();
  });

  it('consequential actions are audited and the audit log is append-only', async () => {
    const logs = await must<{ id: number; action: string }[]>(db().from('audit_logs').select('id, action').eq('event_id', fx.eventId));
    const actions = new Set(logs.map((l) => l.action));
    for (const a of ['registration.create', 'task.checkin', 'task.complete', 'tag.original', 'tag.reprint', 'tag.revoke', 'report.publish', 'choice.select']) {
      expect(actions, a).toContain(a);
    }
    const { error } = await db().from('audit_logs').delete().eq('id', logs[0].id);
    expect(error?.message).toMatch(/append_only/);
  });
});
