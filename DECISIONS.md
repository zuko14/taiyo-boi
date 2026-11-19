# Decision log

Dated 10 Nov 2026 unless noted. “Provisional” means configurable and awaiting the named approval.

## Architecture

| # | Decision | Why |
|---|---|---|
| A1 | Greenfield Next.js 16 + TypeScript + Supabase + Render, as the brief prefers. | Empty folder; stack named in CLAUDE.md §2. |
| A2 | Business rules live in Postgres functions (`SECURITY DEFINER`) called by the app; tables are RLS-protected. | One transactional place to enforce permission, duty context, state machine and audit. A browser bug or a forged request cannot skip a rule. |
| A3 | Config tables (catalogue, packages, stations, prices) accept direct writes under permission policies; a trigger audits every change and, on a live/paused event, refuses it without a reason (`x-audit-reason` header). | Keeps admin CRUD simple while guaranteeing audit + live-change reasons. |
| A4 | Per-event transaction advisory lock around every queue-affecting write. | Row-level station locking deadlocked under parallel completions (found by tests). Serialising per event removed it; each operation takes ~15 ms, far within the camp’s load. |
| A5 | Plain CSS design tokens instead of Tailwind/shadcn. | `ui_ux.txt` is specified as CSS custom properties and component classes; a second styling system would add weight without benefit. |
| A6 | Server actions + `?ok/err` flash instead of a client data layer. | Few moving parts; works without client JS; idempotency keys embedded per form render. |
| A7 | Realtime is a refresh trigger only; every view re-reads from the database, with 10–20 s polling fallback and a visible connection indicator. | CLAUDE.md §2.3. |
| A8 | Participant portal is served by the server with the service role, keyed by the SHA-256 of a 256-bit token. Participants have no Supabase account. | No public table access; tokens revocable; nothing personal in the QR. |
| A9 | Tag issue = new token. Reprints always rotate the token and revoke the old QR (reason required, `tag.reprint`). | Plaintext tokens are never stored, so a reprint cannot reproduce the old QR. |
| A10 | `shift.assign` is separate from `staff.manage`; only `permissions.manage` holders can grant Event Admin. | Prevents a supervisor from escalating their own access. |

## Business rules implemented as configuration (from the brief)

| # | Rule | Where |
|---|---|---|
| B1 | Exactly two package categories (`unique(event, classification)`, classification ∈ female/male). | `packages` |
| B2 | Brochure templates loaded by `apply_brochure_template`; all items editable. B2/BT2/D kept verbatim (`B2, BT2` is one item, code `B2-BT2`, preserving both labels). T3/T4/TSH and TFT kept separate. | migration 006 |
| B3 | Female USG = choice group “Thyroid or Breast”, default rule *one_of*; rule changeable to one-or-more or bundled. Male USG Thyroid is a single walk-in task. | `choice_groups` |
| B4 | Sponsored package lines can never carry a charge (check constraint). Add-ons carry an immutable price snapshot. | `order_items` |
| B5 | Sponsor rates stored backend-only; settlement unit stored as `unconfirmed`; **no payable amount is calculated anywhere**. | `sponsor_backend_rates` |
| B6 | Attendance ledger: one immutable row per order line per kind (appeared/completed/no_show/exception); retries are no-ops. | `task_attendance_events` |
| B7 | No clinical priorities or fasting rules invented: all services priority 100, fasting off, no dependencies. Admin can set them once the Lab Partner approves. | template |
| B8 | Code format `BOI-{F|M}-YYYY-NNNNNN`, counters per event + classification, editable prefix/format. | `events`, `package_code_counters` |
| B9 | Payments are verified manually by a cashier with a reference/UTR; no gateway is claimed. Approved methods are an event setting and start **empty**. Maker-checker on by default. | `verify_payment` |
| B11 | An add-on in the same workflow service as a package test (e.g. CA-125 with sample collection) stays its own task (keeps sponsored vs employee-paid separate) but is **completed in the same visit** when it is paid by then; the station screen lists it beforehand. Unpaid add-ons are not included and get their own visit after payment. | `task_action` (migration 009) |
| B12 | The add-on desk only offers tests outside the participant's package; add-on-enabled tests already in the package are listed as “already free”. E.g. PSA/TFT/X-Ray are offered to Female participants only. | add-on desk |
| B13 | A participant who walks up to a different station offering the same service can be taken over there (“Serve here instead”, waiting tickets only, audited). Ending the last shift at a station moves its waiting tickets. | `claim_task`, `end_staff_assignment` |
| B10 | Reports: upload → validate (different person by default) → publish. Accession mismatch → `requires_review`. Only published reports reach the portal, after OTP. | `report_*` |

## Provisional (needs approval before production)

| Item | Current state | Owner |
|---|---|---|
| Workflow grouping | Lab analytes (incl. B2/BT2/D) grouped into one “Sample collection (provisional grouping)” visit; ECG, X-Ray, BMD, Body Composition separate; USG walk-in. Readiness shows a warning until `grouping_approved`. | Lab Partner |
| Lab Partner name, walk-in centre name/address/hours/validity | Placeholders; readiness warns. | Client / Lab Partner |
| Participant fields | Name required; age, employee ID, mobile optional; email/department hidden under “optional”. | Client |
| Label size | 90 × 55 mm default; editable. | Client (hardware) |
| OTP provider | None. `console` adapter is development-only. Without a provider participants cannot open reports. | Client |

## Known limitations / shortcuts

- Grouping is per event (a test maps to one service), not per package. Add `package_id` to `workflow_service_tests` if needed.
- Parallel task routing (more than one active assignment) is not implemented; the unique index enforces one.
- Rate limiting of public portal endpoints is in-memory per instance (fine for one Render instance; move to a shared store if scaled out). OTP requests are also limited in the database (3 per 15 min, 5 attempts).
- Exports are CSV only (no XLSX/PDF).
- `separate_tasks` choice groups only split on first selection; changing them later requires cancelling tasks.
- No offline mode: the documented paper fallback applies (see runbook).
- `.env.example` was not created because a local guardrail blocks writing `.env*` files; variables are documented in the README.

## 2026-11-18 — event lifecycle, custom packages, camera scanning

- **Package mode** (`events.settings.package_mode`): `female_male` for events created from the Bank of India brochure template (exactly two packages, rates backend-only, unchanged behaviour); `custom` for every other camp, where the Event Admin creates any number of packages (`create_package` / `delete_package`). A package's classification slug is its lowercased code; registration codes use the package's code letter, now unique per event.
- **Package price (custom events)** is what the participant pays (`packages.price_paise`, blank/0 = free). Registration snapshots it into the package order and creates one payment; all package tasks carry that payment, so the queue and walk-in check-in wait until a cashier verifies it (or it is waived / a supervised exception). Package payments cannot be "cancelled" like add-ons; a refund leaves performed work recorded. Female/Male (BOI) packages can never carry a participant price.
- **Lab UPI QR**: the admin enters the lab's UPI ID (settings `upi_vpa`, `upi_payee_name`). Desks, the cashier screen and the participant portal show a `upi://pay` QR with the exact amount and the registration code as note. A static UPI ID gives no payment callback, so **payment is not auto-confirmed**: the cashier verifies by UTR (or cash count). Automatic confirmation needs a payment-gateway account (webhook) — not integrated.
- **Revenue insights** (`revenue_insights`, `finance.view`): verified transactions minus refunds only — never orders or displayed QRs — with packages vs add-ons, method, hourly timeline, top items and cashier. `addon_revenue` is now strictly add-on orders so package money never inflates it.
- **Pilot reset** (`reset_event`, permission `event.reset`, typed event code + reason): deletes all participant/operational data and report files, keeps configuration, staff and audit log, closes stations, clears shifts, restarts codes, sets status Draft.
- **Event delete** (`delete_event`, platform admin only, not while live): removes the event, its configuration and its audit rows; a platform-level `event.delete` audit row (event_id null) keeps code/name.
- Append-only tables can be emptied only inside these purge functions (transaction-local `app.purge` flag).
- **Catalogue delete** (`delete_test`): allowed only while no participant order references the test; also removes it from packages and add-on prices. Otherwise archive.
- **Camera scanning**: every scan box has a Camera button. Android Chrome uses the native BarcodeDetector (QR + Code 128); other browsers (iOS Safari, Firefox) fall back to jsQR (QR only). Requires HTTPS. `Permissions-Policy` now allows `camera=(self)`.

## 2026-11-19 — pay-per-test camps, catalogue CSV import, queue re-check

- **Pay-per-test (custom events)**: the registration desk ticks the event's priced tests ("Sell to participants"); `register_participant(..., p_test_ids)` creates the registration and the paid test order **in one transaction** (a bad test rolls the whole registration back). Patients with no package go on an automatic `PAY_PER_TEST` package (no tests of its own; created on first use with an audited system reason). Tests queue only after the cashier verifies payment. BOI (female/male) events still sell extras only at the add-on desk.
- **Catalogue CSV import** (`import_catalog`, `catalogue.edit`; prices also need `addon.price.edit`): upsert by code, atomic, ≤2000 rows. Blank code → generated from the name; blank service → `SAMPLE` (event day) / `WALKIN` (walk-in), auto-created. A changed price replaces the active one; orders keep their snapshot. Accepts the template and the lab's "MRP" sheet headers (Test Description / MRP (INR) / Category). Excel must be saved as CSV (no xlsx parser added). The browser preview is never trusted; the server re-parses.
- **Queue re-check**: assignment previously ran only on registration, station open, shift assign, call-next and going live, so a shift whose start time arrived later left patients waiting forever. Every live staff page render now calls `nudge_waiting`, a no-op unless a waiting patient has a compatible open station with staff on shift now. The participant page lists, per compatible station, exactly what is missing (closed / no shift until hh:mm / not mapped).

## 2026-11-19 — fully automatic queue (no "Call next")

- Assignment is unchanged: lowest estimated wait (people queued/in service × minutes ÷ staff on shift) among compatible open staffed stations, then round-robin.
- **Auto-call**: a station has `least(capacity, staff on shift)` service slots. Whenever a slot is free, the next participant in its queue is set to *called* by the system (portal: "go now"). Staff only press Start, Complete, or No-show.
- **Auto-move**: a free station with an empty queue takes the longest-waiting participant from a compatible station that cannot serve them now (all slots busy, unstaffed, or not open). Called or in-service participants are never moved by this rule; each move is audited (`queue.auto_move`).
- `_autoflow` runs at the end of every scheduling decision (registration, payment, completion, no-show, station open/close, shift changes, and the page-refresh nudge), inside the event advisory lock, so it is serialised with all queue writes. Ending a station's last shift now also re-routes its *called* participants. `call_next` was removed from the UI and the RPC allowlist.
- No automatic no-show timer: a called participant who never arrives holds the slot until staff press No-show (a timeout needs an approved duration).

## 2026-11-19 — queue readiness (root cause of live "No station free")

- The scheduler only assigns to stations that are **open, accepting, and have staff on shift now** (CLAUDE.md §5.4). Live events could reach a state where no station qualified: new stations start closed, Reset closes stations and clears shifts, shifts expire. Going live only warned.
- Now: (1) a never-opened station opens automatically when its first shift is assigned (supervisor-closed/paused stations never reopen by themselves); (2) going Live is refused while no diagnostic station is open with staff on shift; (3) Queue control shows per-service coverage with the exact missing piece and one-click Open / Assign shift; (4) `/api/health` reports `schema: outdated` if the app runs without its migrations.

## Open approvals (CLAUDE.md §20 highest priority)

1. Lab Partner approval of catalogue, order codes, and test→visit grouping.
2. Walk-in centre details and attendance/appointment rules.
3. Sequencing / fasting rules.
4. Add-on prices and the payment verification method.
5. Station / counter / staff roster.
6. Printer, label and scanner specifications (and a real print/scan test).
7. Report upload / matching process (manual vs LIS) and identifiers.
8. Signed-off sponsor settlement unit/formula.
