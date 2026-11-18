# Engineering Session Log — 2026-11-18

**Repository:** `boi-taiyo` (`https://github.com/zuko14/taiyo-boi`)  
**Base Commit:** `0ffba9e` (`fix: pass live status and default audit reason for staff management actions`)  
**Session Status:** Verified locally (**66 automated tests passing**, lint, typecheck, and production build passing). Migrations `20261118000011` and `20261118000012` applied to hosted Supabase (`sgnflkglfkoqvfzjbrnr`); committed and pushed to `origin/main` for Render (`https://taiyo-boi.onrender.com`) deployment.

---

## Executive Summary

This session implemented **six major features** plus supporting bug fixes, database migrations, and automated test suites:

1. **Kriya "K" Logo Fix** — Fixed SVG gradient coordinates so the vertical stem of the "K" renders cleanly in both the in-app mark and browser favicon.
2. **Phone & Tablet Camera Scanning** — Added live camera QR/barcode scanning to every `ScanBox` across the app, with HTTPS `Permissions-Policy` update and `jsqr` fallback for iOS Safari / Firefox.
3. **Event Lifecycle: Pilot Reset & Owner Delete** — Added `reset_event` (operational purge keeping setup) and `delete_event` (permanent removal for platform admins) with Danger Zone UI and storage file cleanup.
4. **Custom Packages & Test Catalogue Enhancements** — Introduced `package_mode` (`female_male` vs `custom`) so non-BOI camps can create/rename/delete unlimited packages, set package prices, delete unused tests, and set add-on prices inline.
5. **Participant-Paid Packages & Lab UPI QR** — Enabled participant-paid packages on custom events, automatic `orders`/`payment_intents` creation at registration, task gating until payment verification, `upi://pay` QR generation across desks/payments/portal, and package-aware receipts.
6. **Revenue Insights & Add-on Revenue Separation** — Added a live-updating `/e/[eventId]/revenue` dashboard powered by `revenue_insights(uuid)` counting verified payments minus refunds, and isolated `addon_revenue(uuid)` strictly to add-on orders.

---

## Pin-to-Pin Technical Breakdown

### 1. Kriya "K" Logo Fix

**Root Cause:** The vertical left bar (`<path d="M11.2 7.6v16.8" />`) has zero bounding-box width (`x` is constant at `11.2`). SVG default `gradientUnits="objectBoundingBox"` collapses on zero-width geometry, causing browsers to skip painting the stroke so only the `<` arm was visible.

**Exact Changes:**
- `src/components/Icons.tsx`: Updated `KriyaMark()` gradients (`#km-hex`, `#km-stem`, `#km-arm`) to use `gradientUnits="userSpaceOnUse"` with explicit viewBox coordinates (`x1="4" y1="2" x2="28" y2="30"`, `y1="7.6" y2="24.4"`, etc.).
- `public/favicon.svg`: Applied the exact same `gradientUnits="userSpaceOnUse"` coordinate fix to `#h`, `#s`, and `#a`.

**Where to Debug if Broken:** Check SVG `<defs>` in `src/components/Icons.tsx` and `public/favicon.svg`. Verify the browser is not serving a cached `favicon.svg`.

---

### 2. Phone & Tablet Camera Scanning

**Goal:** Allow staff on phones/tablets to scan participant tags directly with the device camera wherever a `ScanBox` appears (Add-on desk, Stations, Walk-in centre, Reports).

**Exact Changes:**
- **Dependency:** Added `jsqr@^1.4.0` to `package.json` and `package-lock.json` for QR decoding on browsers lacking native `BarcodeDetector`.
- **Security Header (`next.config.ts`):** Changed `Permissions-Policy` from `camera=(), microphone=(), geolocation=()` to `camera=(self), microphone=(), geolocation=()`. Without this header change, browsers block `getUserMedia` even on HTTPS.
- **Icon (`src/components/Icons.tsx`):** Added `camera` SVG path to `P`.
- **Camera Component (`src/components/CameraScan.tsx` — NEW):**
  - Renders a **Camera** button only when `window.isSecureContext && !!navigator.mediaDevices?.getUserMedia` (hidden on plain HTTP or SSR; uses `useSyncExternalStore` to avoid hydration mismatches).
  - Requests rear camera (`facingMode: { ideal: 'environment' }`, `1280x720`, `audio: false`).
  - **Decoder strategy (`makeDecoder`):**
    1. Native `BarcodeDetector` if available and supporting `qr_code` / `code_128` (Android Chrome: reads both QR and Code 128).
    2. Fallback dynamic import of `jsqr` on a hidden `<canvas>` scaled to max `720px` (iOS Safari, Firefox: reads QR only — sufficient since all tags include QR).
  - Polls every `120ms`; on decode: vibrates (`60ms` if supported), closes modal, sets `input[name="scan"]` inside the closest `<form>`, and triggers `form.requestSubmit()`.
  - Supports `Escape` key to close and stops all `MediaStreamTrack`s on unmount/close.
  - Translates `NotAllowedError` / `SecurityError`, `NotFoundError` / `OverconstrainedError`, and `NotReadableError` into plain-language messages.
- **ScanBox Integration (`src/components/ScanBox.tsx`):** Mounted `<CameraScan />` next to the scan input and **Find** button.
- **Responsive Styles (`src/app/globals.css`):** Added `.cam-btn`, `.cam-overlay`, `.cam-frame`, `.cam-target`, `.cam-hint`. Below `640px`, `.scan` wraps so the input spans 100% and **Camera** + **Find** split the row equally (`min-height: 48px`).

**Where to Debug if Broken:**
- Camera button missing? Verify the page is served over **HTTPS** (or `localhost`), not plain HTTP.
- Permission denied immediately without prompt? Verify `next.config.ts` `Permissions-Policy: camera=(self)` is deployed and present in HTTP response headers.
- Decodes but doesn't submit? Check that the enclosing `<form>` contains `<input name="scan">` (required by `CameraScan.tsx:68-71`).

---

### 3. Event Lifecycle: Pilot Reset & Owner Delete

**Database Migration:** `supabase/migrations/20261118000011_event_lifecycle_custom_packages.sql`

#### Database Changes
- **Append-Only Purge Guard (`public.forbid_mutation()`):** Allows `DELETE` on append-only tables **only** when transaction-local GUC `current_setting('app.purge', true) = 'on'`. Clients cannot set GUCs via PostgREST.
- **Config Audit Bypass During Event Delete (`public.config_audit()`):** Skips writing `audit_logs` rows if `current_setting('app.purging_event', true) = v_event::text` so cascaded deletions during `delete_event` do not fail or pollute logs.
- **New Permission:** Inserted `event.reset` into `public.permissions`, mapped to `event_admin` in `public.default_role_permissions`, and backfilled into `public.role_permissions` for all existing events.
- **Internal Helper (`public._purge_operational(p_event uuid)` — revoked from `public/anon/authenticated`):**
  - Sets `app.purge = 'on'`, collects all `reports.storage_key` values for storage cleanup, and deletes all operational records in FK-safe order:
    `portal_sessions`, `portal_otps`, `report_import_jobs`, `reports`, `scan_events`, `task_attendance_events`, `task_status_history`, `queue_assignments`, `task_items`, `participant_tasks`, `walkin_visits`, `receipts`, `refunds`, `payment_transactions`, `payment_intents`, `order_items`, `orders`, `tag_prints`, `registration_tokens`, `registrations`, `participants`, `package_code_counters`, `staff_assignments`, `station_events`.
  - **Preserves:** `events`, `packages`, `package_tests`, `choice_groups`, `test_catalog`, `workflow_services`, `workflow_service_tests`, `addon_prices`, `stations`, `station_capabilities`, `event_memberships`, `role_permissions`, `member_permission_overrides`, `audit_logs`.
- **RPC `public.reset_event(p_event uuid, p_confirm_code text, p_reason text) returns text[]`:**
  - Locks event (`_lock_event`), checks `is_platform_admin() or has_perm(p_event, 'event.reset')`.
  - Requires `upper(btrim(p_confirm_code)) = e.code` (`confirm_mismatch`) and non-empty `p_reason` (`reason_required`).
  - Calls `_purge_operational(p_event)`, resets all stations (`status = 'closed'`, `pause_reason = null`, `next_seq = 1`, `last_assigned_at = null`), resets event (`status = 'draft'`, `receipt_seq = 0`), writes `event.reset` audit log entry, and returns report `storage_key[]`.
- **RPC `public.delete_event(p_event uuid, p_confirm_code text) returns text[]`:**
  - Locks event, requires `is_platform_admin()` (`permission_denied`), matching `p_confirm_code` (`confirm_mismatch`), and `e.status <> 'live'` (`event_live` — must pause or close first).
  - Calls `_purge_operational(p_event)`, sets `app.purging_event`, deletes all config/membership/audit tables in FK-safe order, deletes the `events` row, writes a platform-level audit entry (`event_id = null`, `action = 'event.delete'`), and returns report `storage_key[]`.

#### Application Changes
- **Server Actions (`src/app/e/[eventId]/admin/actions.ts`):**
  - `removeReportFiles(keys)`: Uses `serviceClient().storage.from('reports').remove(...)` in batches of 100 after DB commit; logs errors without failing the already-committed reset/delete.
  - `resetEvent(fd)`: Calls `reset_event` RPC, cleans storage files, revalidates `/e/${eventId}` layout.
  - `deleteEvent(fd)`: Verifies `ctx.profile.is_platform_admin`, calls `delete_event` RPC, cleans storage files, revalidates `/platform` and `/select-event`, redirects to `/platform`.
- **UI:**
  - `src/app/e/[eventId]/admin/event/page.tsx`: Added **Danger zone** card visible to `event.reset` holders and platform admins, with typed event code confirmation and confirmation dialog.
  - `src/app/platform/page.tsx`: Added **Delete an event** card listing all events with `<details>` confirm forms. Also clarified the BOI brochure template checkbox description.
- **Error Mapping (`src/lib/errors.ts`):** Added plain-language mappings for `confirm_mismatch`, `event_live`, `in_use`, `package_mode`, `invalid_code`, `invalid_classification`, and `23503`.

**Where to Debug if Broken:**
- Reset/delete fails with `append_only` error? A newly added table may have the `forbid_mutation` trigger without being deleted inside `_purge_operational` (or before `app.purge = 'on'`).
- Delete fails with FK violation (`23503`)? Check table deletion order in `delete_event` (`20261118000011_event_lifecycle_custom_packages.sql:137-152`).
- Orphaned PDFs in Supabase Storage? Check server logs for `report file cleanup failed` in `removeReportFiles`.

---

### 4. Custom Packages & Test Catalogue Deletion / Inline Pricing

**Database Migration:** `supabase/migrations/20261118000011_event_lifecycle_custom_packages.sql`

#### Database Changes
- **Classification Constraint Relaxation:** Relaxed `packages`, `registrations`, `package_code_counters`, and `sponsor_backend_rates` classification checks from `('female', 'male')` to `^[a-z0-9_]{1,30}$`.
- **Package Price Column:** Added `public.packages.price_paise bigint check (price_paise is null or price_paise >= 0)`.
- **Unique Code Letter:** Added unique index `packages_event_code_letter on public.packages (event_id, code_letter)` so custom packages cannot generate colliding registration codes.
- **Package Mode (`events.settings.package_mode`):**
  - Backfilled existing events: `'female_male'` if they have `female`/`male` packages, else `'custom'`.
  - Patched `apply_brochure_template(uuid)` to stamp `"package_mode": "female_male"`.
  - Added helper `public.package_mode(p_event uuid)` (defaults to `'custom'`).
  - Added trigger `packages_mode_guard` on `public.packages`: rejects any non-`female`/`male` classification OR any non-null `price_paise` on `female_male` events (`package_mode` error).
- **New RPCs:**
  - `public.create_package(p_event, p_code, p_name, p_code_letter, p_description)` — requires `package.edit` and `package_mode = 'custom'`; validates `^[A-Z0-9_]{1,30}$`; sets `classification = lower(v_code)`.
  - `public.delete_package(p_package, p_reason)` — requires `package.edit` and `package_mode = 'custom'`; blocks if `registrations` reference the package (`in_use`); cleans `package_configuration_versions`, `sponsor_backend_rates`, `package_tests`, `choice_groups`, and `packages`.
  - `public.set_package_rate(p_package, p_amount_paise, p_reason)` — requires `package.edit` and `package_mode = 'custom'`; stores `nullif(p_amount_paise, 0)` on `packages.price_paise`; writes `package.rate` audit log.
  - `public.package_rates(p_event)` — requires `package.edit`; returns empty for `female_male` events (keeps BOI ₹2,999 / ₹1,999 rates hidden).
  - `public.delete_test(p_test, p_reason)` — requires `catalogue.edit`; blocks if `order_items` reference the test (`in_use`); removes linked `package_tests`, `addon_prices`, and `test_catalog` (cascading `workflow_service_tests`).
- **Updated RPCs (Patched via `pg_get_functiondef`):**
  - `public.register_participant`: Validates `p_classification` against any configured package in `packages` for the event (instead of hardcoded `female`/`male`).
  - `public.validate_event(uuid)`: Checks missing `female`/`male` only when `package_mode = 'female_male'`; checks `"No active package configured"` when `package_mode = 'custom'`.
  - `public.sponsor_summary(uuid)`: Iterates over configured `packages` instead of hardcoded `female`/`male`.
  - `public.dashboard_overview(uuid)`: Added `by_package` breakdown array (`[{ name, classification, count }]`).

#### Application Changes
- **Server Actions (`src/app/e/[eventId]/admin/actions.ts`):**
  - Added `deleteTest`, `createPackage`, `deletePackage`, `setPackageRate`.
  - Updated `saveTest`: If `price` field is supplied and user has `addon.price.edit`, deactivates prior active `addon_prices` rows for that test and inserts a new active price row (existing orders preserve their snapshot).
- **Pages & Components:**
  - `src/app/e/[eventId]/admin/packages/page.tsx`: In `custom` mode, renders **Create package** form, per-package **Price paid by the participant (₹)** form, **Delete package** button, and quick link to Test Catalogue. In `female_male` mode, preserves exact BOI UI with hidden rates.
  - `src/app/e/[eventId]/admin/catalog/page.tsx`: Added inline **Add-on price (₹)** field in the test create/edit form and **Delete** button (with `in_use` guard).
  - `src/app/e/[eventId]/register/page.tsx`: Renders dynamic package cards (`Package (required)` in custom mode, `Classification (required)` in BOI mode) showing `Participant pays ₹X` or free/sponsored wording.
  - `src/app/e/[eventId]/page.tsx`: Dashboard renders **By package** stat tile for custom events instead of **Female / Male**.
  - `src/app/e/[eventId]/participants/page.tsx`: Filter dropdown dynamically lists all configured packages instead of hardcoded Female/Male; validates `cls` against `/^[a-z0-9_]{1,30}$/`.
  - `src/components/ui.tsx`: `SourceTag` accepts `custom?: boolean` to show `Package test` / `Add-on · participant-paid` on custom events vs `Sponsored · ₹0` / `Add-on · employee-paid` on BOI events. Updated callers in `addons/page.tsx`, `walkin/page.tsx`, `participants/[regId]/page.tsx`.
  - `src/lib/format.ts`: `classLabel()` formats custom slugs (`executive_check` → `Executive check`).
  - `scripts/lib/fixture.ts`: Stamps `package_mode: 'female_male'` in test fixture event settings.

**Where to Debug if Broken:**
- Can't create a package on a new camp? Check `events.settings->>'package_mode'`. If created with the BOI template checkbox ticked, it is locked to `'female_male'`.
- Duplicate code letter error? Two packages in the same event cannot share `code_letter` (enforced by unique index `packages_event_code_letter`).
- Test/package delete rejected? Check if any `order_items` or `registrations` reference it; if so, archive/deactivate instead.

---

### 5. Participant-Paid Packages & Lab UPI QR

**Database Migration:** `supabase/migrations/20261118000012_package_payments_revenue.sql`

#### Database Changes
- **`register_participant` Patch:** When `coalesce(pkg.price_paise, 0) > 0`:
  - Inserts an active `orders` row with `kind = 'package'` and `total_paise = pkg.price_paise` (price snapshot).
  - Inserts a `payment_intents` row linked to that order for `pkg.price_paise`.
  - Returns `payment_intent_id` in the JSON response alongside `registration_id`, `registration_code`, and `assignment_id`.
- **Trigger `package_task_payment` (`BEFORE INSERT ON public.participant_tasks`):**
  - Automatically attaches the active package `payment_intent_id` to every `source = 'package'` task (including tasks created later via choice-group selection or config migration).
  - Because existing queue scheduler and walk-in check-in already gate tasks on `payment_cleared`, unpaid package tasks are **never queued** and **cannot be checked in at walk-in** until a cashier verifies payment (or waives/overrides).
- **`_issue_receipt(uuid)` Patch:** Adds a `'package': { name, amount_paise }` object into the receipt JSON snapshot when the paid order has `kind = 'package'`.
- **`portal_view(text)` Patch:**
  - Adds `'kind'` (`'package'` | `'addon'`) to each payment item in the portal payload.
  - Exposes `upi_vpa` and `upi_payee_name` inside `event` so the participant's mobile portal can render the UPI QR and deep link.
- **`payment_action(...)` Patch:**
  - Blocks `p_action = 'cancel'` on `kind = 'package'` orders (`illegal_transition: a package payment cannot be cancelled — waive it (approved) or correct the registration`).
  - Restricts cancelling/voiding order items & tasks on `refunded` to `kind = 'addon'` only, so refunding a package payment leaves performed work recorded.

#### Application Changes
- **UPI Utility (`src/lib/upi.ts` — NEW):**
  - `VPA_RE`: Validates UPI ID format (`^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$`).
  - `upiPayee(settings)`: Extracts validated `{ vpa, name }` from `event.settings`.
  - `upiLink(payee, amountPaise, note)`: Builds NPCI `upi://pay?pa=...&pn=...&am=...&cu=INR&tn=...` with `%20` for spaces and literal `@` in VPA (compatibility fix for Indian UPI apps that reject `+` and `%40`), truncating `tn` to 50 chars.
- **UPI QR Component (`src/components/UpiPay.tsx` — NEW):**
  - Renders SVG QR code (`qrSvg(link)`), formatted INR amount, payee name & VPA, registration code reference, and an **Open in UPI app** deep-link button (hidden on screens `>= 900px` via `.upi-open` CSS).
  - Displays role-appropriate guidance text (`staff = true` vs `staff = false` for patient portal).
- **Admin Setup (`src/app/e/[eventId]/admin/event/page.tsx` & `actions.ts`):**
  - Added **Lab's UPI collection (optional)** fields (`upi_vpa`, `upi_payee_name`) under Operational Settings. `saveEventSettings` validates `upi_vpa` against `VPA_RE` and caps `upi_payee_name` at 60 chars.
- **Surfaces Showing `<UpiPay>`:**
  1. `src/app/e/[eventId]/participants/[regId]/tag/page.tsx`: Right after registration, queries active `kind = 'package'` order and shows **Package payment due · ₹X** card with `<UpiPay>` (marked `no-print` so it doesn't print on the physical tag).
  2. `src/app/e/[eventId]/addons/page.tsx`: Shows `<UpiPay>` inside the **Order created** card for pending/requires_review add-on intents.
  3. `src/app/e/[eventId]/payments/page.tsx`: Shows **For** column (`Package` vs `Add-on`), renders package summary line + included tests for package intents, shows `<UpiPay>` while `pending`/`requires_review`, and hides the **Cancel order** button for package payments.
  4. `src/app/p/[token]/page.tsx`: Shows package price/status badge in header, renders a **Payment due** card with `<UpiPay staff={false} />` for any pending package or add-on payment, and filters the bottom add-ons payment list to `kind === 'addon'`.
- **Receipt Page (`src/app/e/[eventId]/receipts/[intentId]/page.tsx`):** Displays `Package · <name>` + `Includes: <tests>` when `s.package` is present; keeps add-on itemized list otherwise.
- **Styles (`src/app/globals.css`):** Added `.upi-pay`, `.upi-qr`, `.upi-info`, `.upi-amount`, `.upi-open`.

**Important Operational Constraint:**
- A static lab UPI ID / QR does **not** send automated settlement webhooks. A cashier **must** still click **Verify** and enter the UTR (or verify cash) before tasks enter the queue. Automatic confirmation requires a payment gateway integration (Razorpay / Cashfree / PhonePe for Business).

**Where to Debug if Broken:**
- UPI QR not showing? Verify `upi_vpa` is saved in **Event & readiness → Operational settings**, passes `VPA_RE`, and the payment amount is `> 0`.
- Tasks still stuck after verifying payment? Check `participant_tasks.payment_intent_id` and `payment_intents.status` (`paid` / `waived`). Verify `verify_payment` triggers `_schedule_next`.
- "Open in UPI app" button missing on laptop? Intentional — `.upi-open` is hidden at `@media (min-width: 900px)` in `src/app/globals.css`.

---

### 6. Revenue Insights & Add-on Revenue Separation

**Database Migration:** `supabase/migrations/20261118000012_package_payments_revenue.sql`

#### Database Changes
- **Updated `public.addon_revenue(p_event uuid)`:** Scoped every `totals`, `by_method`, and `by_cashier` query with `join orders o on o.id = i.order_id ... and o.kind = 'addon'` so package payments never inflate the Add-on Revenue report.
- **New RPC `public.revenue_insights(p_event uuid)`:**
  - Requires `finance.view` permission. Granted to `authenticated` only.
  - **Accounting Rule:** Counts **only verified `payment_transactions` minus `refunds`**. Unpaid orders, pending intents, and displayed UPI QRs are never counted as revenue; sponsor backend rates are never included.
  - Returns JSON with:
    - `totals`: `collected_paise`, `payments`, `paying_participants`, `first_at`, `last_at`
    - `refunded_paise`
    - `open`: `pending_paise`, `pending_count`, `review_count`, `waived_paise`, `failed_paise`
    - `by_source`: net collected, pending, and paid counts split by `package` vs `addon`
    - `by_method`: verified totals by method (`cash`, `upi_manual`, etc.)
    - `timeline`: verified payments grouped into local-timezone hourly buckets (`events.timezone`)
    - `top_items`: paid package orders and paid add-on test lines ranked by collected amount
    - `by_cashier`: verified payment counts and totals grouped by verifier (`staff_profiles.full_name`)
    - `registrations`: active registration count (for conversion % calculation)

#### Application Changes
- **New Page (`src/app/e/[eventId]/revenue/page.tsx` — NEW):**
  - Guarded by `requirePerm(eventId, 'finance.view')`.
  - Uses `<LiveRefresh>` subscribed to `payment_intents` and `registrations` for live updates.
  - Displays:
    - Hero card with **Net collected** (`collected - refunded`) and an SVG circular gauge (`% of billed money collected`).
    - 5 KPI tiles: *Pending collection*, *Needs review*, *Avg per paying participant*, *Paying participants (%)*, *Refunded / waived*.
    - **Collections over time**: Responsive SVG bar chart (`TimelineChart`) with nice 1-2-5 Y-axis scaling, automatic switch to daily buckets if span > 48h, zero-filled gap hours, hover `<title>` tooltips, and expandable **"View as table"** `<details>`.
    - **Packages vs add-on tests** stacked proportional bar + legend.
    - **By payment method**, **Top earners** (top 8), and **By cashier** horizontal ranked bar lists (`RankBars`).
    - Explicit footnote on `female_male` events clarifying sponsor rates are excluded.
- **Sidebar Navigation (`src/app/e/[eventId]/layout.tsx`):** Added **Revenue insights** (`/revenue`, `trending-up` icon, `finance.view`) above **Add-on revenue** (`/finance`, `wallet` icon, `finance.view`).
- **Styles (`src/app/globals.css`):** Added `.viz` theme-aware palette variables (`--series-1`, `--series-2` for dark & light themes) and chart/gauge/rank classes (`.viz-*`, `.rev-hero`, `.hero-num`, `.rev-gauge`, `.split`, `.legend`, `.rank`).

**Where to Debug if Broken:**
- Numbers don't match between Revenue Insights and Add-on Revenue? Revenue Insights includes **both** `package` and `addon` verified payments minus refunds; Add-on Revenue includes `addon` only.
- Chart empty despite registrations? Check if payments have been **verified** (`payment_transactions.status = 'verified'`). Pending intents only appear in the "Pending collection" tile.
- Wrong chart hours? Timeline buckets use `events.timezone` (`Asia/Kolkata` by default).

---

### 7. Other Fixes & Tests

- **HTML5 `pattern` Regex Fix (Modern `v`-flag compatibility):** Escaped literal hyphens (`\-`) inside character classes in 3 forms where modern Chrome/Safari rejected unescaped `-` in HTML `pattern` attributes:
  - `src/app/platform/page.tsx`: `pattern="[A-Za-z0-9\-]{2,30}"`
  - `src/app/e/[eventId]/admin/catalog/page.tsx`: `pattern="[A-Za-z0-9_\-]{1,40}"`
  - `src/app/e/[eventId]/admin/stations/page.tsx`: `pattern="[A-Za-z0-9_\-]{1,20}"`
- **Flaky Integration Test Fix (`tests/integration/walkin_reports_security.test.ts`):** Tasks created in the same transaction share `created_at`, so `[0]` could occasionally pick a walk-in task. Changed to `.find((x) => x.location === 'event_day')!`.
- **Architecture Log (`DECISIONS.md`):** Documented all 2026-11-18 architectural decisions.
- **New Automated Tests (12 new tests total across both drops → 66 passing):**
  - `tests/integration/lifecycle.test.ts` (NEW): Tests pilot reset permissions/confirm-code/purge/code-restart, catalogue delete vs `in_use`, `female_male` lockouts, custom package creation/pricing/validation/registration/deletion, and platform-admin-only `delete_event` (blocked while live).
  - `tests/integration/package_payments.test.ts` (NEW): Tests paid-package intent creation and task holding until cashier verification, price snapshot immutability on rate updates, `revenue_insights` vs `addon_revenue` accuracy & permissions, cancellation block on package payments, and `female_male` zero-price enforcement.
  - `tests/unit/lib.test.ts`: Added unit tests for `upiPayee()` validation and `upiLink()` formatting (`%20` spaces, literal `@`, exact decimal INR).

---

## Complete File Manifest (39 Files)

### New Files (8)
| File | Purpose |
| :--- | :--- |
| `supabase/migrations/20261118000011_event_lifecycle_custom_packages.sql` | Pilot reset, owner delete, `event.reset` permission, `delete_test`, `package_mode`, custom packages CRUD & pricing, patched registration/validation/dashboard RPCs |
| `supabase/migrations/20261118000012_package_payments_revenue.sql` | Paid-package registration flow, `package_task_payment` trigger, package-aware receipts/portal/payment actions, `addon_revenue` isolation, `revenue_insights` RPC |
| `src/components/CameraScan.tsx` | Full-screen phone/tablet camera QR/Code 128 scanner modal (`BarcodeDetector` + `jsqr`) |
| `src/components/UpiPay.tsx` | UPI QR code + mobile deep-link payment block component |
| `src/lib/upi.ts` | `VPA_RE`, `upiPayee()`, and `upiLink()` NPCI URL builder |
| `src/app/e/[eventId]/revenue/page.tsx` | Live Revenue Insights dashboard (KPIs, gauge, SVG timeline chart, source/method/item/cashier rankings) |
| `tests/integration/lifecycle.test.ts` | Integration tests for reset, delete, test deletion, and custom packages |
| `tests/integration/package_payments.test.ts` | Integration tests for paid packages, price snapshots, and revenue RPCs |

### Modified Files (31)
| File | Summary of Change |
| :--- | :--- |
| `DECISIONS.md` | Recorded 2026-11-18 architectural decisions |
| `next.config.ts` | Updated `Permissions-Policy` to `camera=(self)` |
| `package.json` / `package-lock.json` | Added `jsqr@^1.4.0` |
| `public/favicon.svg` | Fixed Kriya K stem gradient with `gradientUnits="userSpaceOnUse"` |
| `scripts/lib/fixture.ts` | Added `package_mode: 'female_male'` to test fixture settings |
| `src/components/Icons.tsx` | Fixed `KriyaMark()` gradients; added `camera` icon |
| `src/components/ScanBox.tsx` | Embedded `<CameraScan />` into every scan form |
| `src/components/ui.tsx` | Added `custom` prop to `SourceTag` |
| `src/lib/errors.ts` | Mapped new DB errors (`confirm_mismatch`, `event_live`, `in_use`, `package_mode`, `invalid_code`, `invalid_classification`, `23503`) |
| `src/lib/format.ts` | Formatted custom package slugs in `classLabel()` |
| `src/app/globals.css` | Added camera scanner, UPI QR block, and Revenue Insights visualization CSS |
| `src/app/platform/page.tsx` | Added platform-admin **Delete an event** card; escaped pattern hyphen; updated template checkbox copy |
| `src/app/p/[token]/page.tsx` | Rendered participant **Payment due** card with `<UpiPay>` and package price/status badge |
| `src/app/e/[eventId]/layout.tsx` | Added **Revenue insights** sidebar item above **Add-on revenue** |
| `src/app/e/[eventId]/page.tsx` | Showed **By package** counts on dashboard for custom events |
| `src/app/e/[eventId]/register/page.tsx` | Showed dynamic packages and participant package prices on registration cards |
| `src/app/e/[eventId]/addons/page.tsx` | Embedded `<UpiPay>` on created orders; custom-event wording |
| `src/app/e/[eventId]/payments/page.tsx` | Added Package/Add-on indicator, package detail view, `<UpiPay>`, and hid Cancel for package intents |
| `src/app/e/[eventId]/walkin/page.tsx` | Passed `custom` flag to `SourceTag` |
| `src/app/e/[eventId]/participants/page.tsx` | Made package filter dropdown dynamic for custom packages |
| `src/app/e/[eventId]/participants/[regId]/page.tsx` | Custom-event headings and `SourceTag` flags |
| `src/app/e/[eventId]/participants/[regId]/tag/page.tsx` | Added **Package payment due** card with `<UpiPay>` (`no-print`) |
| `src/app/e/[eventId]/receipts/[intentId]/page.tsx` | Rendered package line item + included test list for package receipts |
| `src/app/e/[eventId]/admin/actions.ts` | Added `deleteTest`, `createPackage`, `deletePackage`, `setPackageRate`, `resetEvent`, `deleteEvent`, `removeReportFiles`; added UPI VPA validation & inline test pricing |
| `src/app/e/[eventId]/admin/event/page.tsx` | Added Lab UPI settings inputs and **Danger zone** (Reset / Delete) |
| `src/app/e/[eventId]/admin/catalog/page.tsx` | Added inline Add-on price input, Delete test button, and escaped pattern hyphen |
| `src/app/e/[eventId]/admin/packages/page.tsx` | Added Create/Delete package and Participant price forms for custom events |
| `src/app/e/[eventId]/admin/stations/page.tsx` | Escaped pattern hyphen in station code input |
| `tests/integration/walkin_reports_security.test.ts` | Fixed flaky task selection to pick `location === 'event_day'` explicitly |
| `tests/unit/lib.test.ts` | Added unit tests for `upiPayee` and `upiLink` |

---

## Deployment Checklist (Required Before Live Testing)

Because nothing is committed or deployed yet, execute in this exact order when ready to go live:

1. **Apply Hosted Supabase Migrations (Migrations 11 & 12):**
   ```bash
   supabase db push
   ```
   Verify both `20261118000011_event_lifecycle_custom_packages.sql` and `20261118000012_package_payments_revenue.sql` succeed against `sgnflkglfkoqvfzjbrnr`.
2. **Commit & Push to `origin/main`:**
   - Stage all modified/new files (including `docs/session.md`), commit, and `git push origin main`.
   - Confirm Render finishes building and deploying `https://taiyo-boi.onrender.com`.
3. **Verify Security Headers Live:**
   - Confirm `Permissions-Policy: camera=(self), microphone=(), geolocation=()` is present in `curl -I https://taiyo-boi.onrender.com/`.

---

## Pending Real-Device Verification & Known Limitations

- **Real-Phone Camera Scanning:** Must be tested on actual Android Chrome (QR + Code 128) and iOS Safari/Firefox (QR) over the live **HTTPS** Render URL.
- **Real ₹1 UPI Test Payment:** Scan the generated QR and test the mobile **"Open in UPI app"** button with GPay, PhonePe, and Paytm.
- **Personal vs. Merchant UPI IDs:** Some UPI apps ignore pre-filled `am=` amounts on personal VPAs; use a **lab merchant UPI ID** for reliable amount pre-fill.
- **Manual Cashier Verification:** Static UPI QRs do not emit webhooks — cashiers must still verify via UTR/cash count. Auto-confirmation requires a future payment gateway integration (Razorpay / Cashfree / PhonePe for Business).
- **Participant Portal Mobile Check:** Open a live participant tag URL on a phone to visually confirm the **Payment due** card and UPI deep link rendering.
