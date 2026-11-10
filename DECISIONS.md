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

## Open approvals (CLAUDE.md §20 highest priority)

1. Lab Partner approval of catalogue, order codes, and test→visit grouping.
2. Walk-in centre details and attendance/appointment rules.
3. Sequencing / fasting rules.
4. Add-on prices and the payment verification method.
5. Station / counter / staff roster.
6. Printer, label and scanner specifications (and a real print/scan test).
7. Report upload / matching process (manual vs LIS) and identifiers.
8. Signed-off sponsor settlement unit/formula.
