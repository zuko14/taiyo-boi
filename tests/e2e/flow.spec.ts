import { createHmac, randomBytes, createHash } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { buildEvent, env, must, serviceClient, type Fixture } from '../../scripts/lib/fixture.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let fx: Fixture;

test.beforeAll(async () => {
  fx = await buildEvent({ code: `E2E-${randomBytes(3).toString('hex').toUpperCase()}` });
});

async function login(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByLabel('Staff email').fill(email);
  await page.getByLabel('Password').fill(env().password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/select-event');
  return page;
}

test('register → tag → station → report → publish → participant download', async ({ browser }) => {
  const e = `/e/${fx.eventId}`;

  // registration desk (synthetic participant)
  const reg = await login(browser, fx.users.registration_staff.email);
  await reg.goto(`${e}/register?at=${fx.stations['REG-1']}`);
  await reg.locator('.choice-card', { hasText: 'Female' }).click();
  await reg.locator('#full_name').fill('E2E Synthetic Person');
  await reg.locator('#mobile').fill('9000000077');
  await reg.getByText('consents to registration').click();
  await reg.getByRole('button', { name: 'Register and print tag' }).click();
  await reg.waitForURL(/\/participants\/.+\/tag/);
  const regId = reg.url().split('/participants/')[1].split('/')[0];
  const code = (await reg.locator('h2').innerText()).replace('Tag · ', '').trim();
  expect(code).toMatch(/^BOI-F-\d{4}-\d{6}$/);
  await reg.evaluate(() => { window.print = () => {}; });
  await reg.getByRole('button', { name: 'Print tag' }).click();
  await expect(reg.locator('.tag .t-code')).toHaveText(code);
  await expect(reg.locator('.tag .t-qr svg')).toBeVisible();
  await reg.getByRole('button', { name: 'Printed and attached' }).click();
  await expect(reg.getByText('confirmed printed and attached')).toBeVisible();

  // station: scan code, start, complete
  const { data: qa } = await serviceClient().from('queue_assignments').select('station_id').eq('registration_id', regId).eq('state', 'queued').single();
  const st = await login(browser, fx.users.station_staff.email);
  st.on('dialog', (d) => d.accept());
  await st.goto(`${e}/station?at=${qa!.station_id}&scan=${code}`);
  await expect(st.getByText(`Found: ${code}`)).toBeVisible();
  await st.locator('.next-step').getByRole('button', { name: 'Start' }).click();
  await expect(st.getByText('Service started')).toBeVisible();
  await st.locator('.next-step').getByRole('button', { name: 'Complete' }).click();
  await expect(st.getByText('Completed — next step assigned')).toBeVisible();

  // report upload (maker) and validation/publication (checker)
  const rm = await login(browser, fx.users.report_manager.email);
  await rm.goto(`${e}/reports?tab=upload&reg=${regId}`);
  await rm.getByRole('radio', { name: 'CBC' }).check();
  await rm.locator('#file').setInputFiles({ name: 'cbc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% synthetic test report\n%%EOF\n') });
  await rm.getByRole('button', { name: 'Upload report' }).click();
  await expect(rm.getByText('waiting for validation by a different person')).toBeVisible();
  await rm.goto(`${e}/reports?tab=validate`);
  await expect(rm.getByRole('button', { name: 'Validate' })).toBeDisabled();       // maker-checker

  const admin = await login(browser, fx.users.event_admin.email);
  admin.on('dialog', (d) => d.accept());
  await admin.goto(`${e}/reports?tab=validate`);
  await admin.getByRole('button', { name: 'Validate' }).click();
  await expect(admin.getByText('Validated', { exact: true }).first()).toBeVisible();
  await admin.goto(`${e}/reports?tab=publish`);
  await admin.getByRole('button', { name: 'Publish' }).click();
  await expect(admin.getByText('Published to participant')).toBeVisible();

  // participant: new tag token (supervisor reprint), OTP, download
  const token = randomBytes(32).toString('base64url');
  await must(fx.users.registration_supervisor.client.rpc('issue_tag', { p_reg: regId, p_token_hash: sha(token), p_reason: 'e2e reprint' }));
  const p = await (await browser.newContext()).newPage();
  await p.goto(`/p/${token}`);
  await expect(p.getByText(code)).toBeVisible();
  await p.goto(`/p/${token}/reports`);
  await p.getByRole('button', { name: 'Send me a code' }).click();
  await p.waitForURL(/sent=1/);
  // the dev SMS adapter only logs; the test replaces the pending code with one it knows
  const otp = '424242';
  const secret = process.env.OTP_HMAC_SECRET!;
  await must(serviceClient().rpc('portal_otp_request', { p_token_hash: sha(token), p_code_hash: createHmac('sha256', secret).update(`${sha(token)}:${otp}`).digest('hex') }));
  await p.getByLabel(/6-digit code/).fill(otp);
  await p.getByRole('button', { name: 'Verify' }).click();
  const link = p.getByRole('link', { name: 'Open' });
  await expect(link).toBeVisible();
  const res = await p.request.get(await link.getAttribute('href') as string);
  expect(res.status()).toBe(200);
  expect((await res.body()).subarray(0, 5).toString()).toBe('%PDF-');

  // the old tag token no longer works
  await reg.goto(`${e}/participants/${regId}`);
  await expect(reg.getByText('v2 · reprint')).toBeVisible();
});
