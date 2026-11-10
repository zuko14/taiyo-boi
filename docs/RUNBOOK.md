# Runbook — deployment, event day, fallback, recovery

## 1. Environments

Use **separate** Supabase projects and Render services for staging and production. Never load real
participant data into development or staging.

## 2. First deployment (per environment)

1. Create the Supabase project (region close to the venue). In Auth settings, disable public sign-up
   and turn on leaked-password protection; enable MFA for admin/report/finance accounts if approved.
2. Link and apply migrations from this repo (never edit schema in the dashboard):
   ```bash
   supabase link --project-ref <project-ref>
   ```
   ```bash
   supabase db push
   ```
3. Confirm the private `reports` bucket exists and is **not** public (migration 007 creates it).
4. Create the Render service from `render.yaml`; set `APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` as secrets. `SMS_PROVIDER=none` until a
   real provider adapter is built and tested.
5. Create the first platform admin: create the user in Supabase Auth, then insert a
   `staff_profiles` row with `is_platform_admin = true` (SQL editor, audited by your change process).
6. Sign in → Platform administration → create the event (optionally with the brochure template).
7. Check `/api/health` returns `{"ok":true}`.

## 3. Event setup checklist (Event & readiness page)

- [ ] Lab Partner name, venue, help contact, timezone, registration window
- [ ] Package tests, choice group rule, test→service grouping approved (tick *grouping approved*)
- [ ] Add-on catalogue + prices from the finance owner; approved payment methods + instructions
- [ ] Counters, add-on desks, diagnostic stations (capabilities, capacity), walk-in centre (address, hours, validity)
- [ ] Staff accounts, roles, shifts for every counter/station
- [ ] Label size; **Test print** on the real printer/stock; scan barcode + QR with the real scanners and phones
- [ ] Readiness shows no errors → set status **Live** on event morning

## 4. Event day

- Dashboard → alerts for unstaffed open stations, waiting-with-no-station, payment/report reviews, exceptions.
- Queue control → pause/close a station (waiting tickets move automatically; in-service never moves),
  requeue no-shows/exceptions, reassign with a reason, *Re-run allocation* after adding staff.
- A station only receives work when it is **open**, has a staff member **on shift**, and accepts assignments.
- Lost tag → participant page → *Revoke lost tag*, then *Reprint* (supervisor, with reason).
- Duplicate registration → participant page → *Void as duplicate* (keeps both records, links them).

## 5. Manual fallback (network or system outage)

No offline mode exists. If the system is unreachable:

1. Staff see “Offline — changes may not be saved”. Do **not** retry repeatedly; the UI never shows success
   unless the database confirmed it.
2. Switch to the printed fallback sheets: registration (name, classification, employee ID, mobile,
   counter, time, staff initials) and station logs (sheet number, participant name/code, service,
   start/end time, staff initials).
3. When service returns, a supervisor enters fallback registrations at a counter (duplicate check
   first), and station staff record completions through the normal screens. Every entry is attributed
   and audited; duplicate completions are rejected by the state machine.

## 6. Backups and recovery

- Enable Supabase daily backups / PITR for production. **Test a restore into a scratch project before
  the event** and record the result.
- Render: keep the previous deploy available for instant rollback; run migrations on staging first.
- Rollback of a bad migration = forward-fix migration (never edit applied migrations).

## 7. Before production (not yet done)

- Hosted staging deployment and smoke test (nothing has been deployed yet).
- Real hardware: printer model, label stock, scanners, phones, venue Wi-Fi.
- Payment verification rehearsal with the agreed method; OTP provider integration and test.
- Lab Partner sign-off on catalogue, grouping, sequencing; walk-in centre details.
- Load test on staging over the venue network; RLS review by a second engineer.
- Privacy notice, consent text, retention/deletion policy approved by the client.
- Full rehearsal with trained staff and synthetic participants; named on-call contact.
