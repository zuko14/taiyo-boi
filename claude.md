# CLAUDE.md — Employee Health Camp Operations Platform

> **Purpose of this file:** This is the product and implementation brief for Claude Code. Build the application described below as a reliable, auditable event-operations system. Do not treat this as a generic hospital-management system or a simple registration form.
>
> **Companion UX specification:** Read ui_ux.txt before implementing any user-facing screen. `CLAUDE.md` defines business rules, data, security, and system behaviour; `UI_UX.txt` defines the screen layouts, visual system, responsive behaviour, and interaction design. Both files are required inputs.
>
> **Project status:** Requirements brief with client-confirmed event rules and a configurable initial package catalogue. The two package categories and sponsor reference rates are known for this event. Keep operational settings editable, preserve unresolved clinical/settlement details as explicit configuration, and do not invent medical interpretations, payment integrations, or external laboratory integrations.

---

## 1. Product purpose and operating context

Build a web-based operations platform for an employee health-check camp arranged for **Bank of India employees** by the organizing laboratory/service partner (referred to provisionally in this document as the **Lab Partner**). The Lab Partner's exact legal/display name must be confirmed before launch; the spoken project description used more than one name (including Taiyo/Tiyo Labs and Thyrocare). Do not hard-code an unconfirmed brand name.

The event is expected to handle approximately **400–500 employees**. The application will be used by multiple registration counters, add-on/payment staff, multiple diagnostic stations, walk-in-centre staff, administrators, and report staff. It must coordinate the full participant journey and give the participant a clear view of their own progress.

### Commercial model

1. Bank of India sponsors exactly **two package categories for this event**: the Male package and the Female package. The event registration classification has two options (Male/Female) and maps to the corresponding package. Do not create a third package category for this event. The mapping and package contents remain editable by an authorized Event Admin.
2. The employee pays **nothing** for either sponsored package or its included tests. The brochure rates (Female ₹2,999; Male ₹1,999) are sponsor-to-Lab-Partner amounts/reference rates held only in restricted backend configuration. They are not employee charges and must not be shown anywhere in the application UI or ordinary exports.
3. An employee may request tests that are not included in their package. These are **add-on tests**. The employee pays the configured price for each add-on; these charges must not be included in the sponsor-funded package amount.
4. Some package tests are performed at the event venue and the underlined USG screening items are performed later at the designated walk-in centre. The system must track both groups and distinguish registered, arrived/appeared, in progress, completed, pending, no-show, skipped, and exception states.
5. The Lab Partner is responsible for performing/processing tests and uploading or integrating reports. A report must only appear to the participant after it has been successfully uploaded, associated with the correct participant/test, and explicitly published.

### Main outcome

A participant registers once, receives a unique registration identity and printed tag, can add optional paid tests, is guided through the next suitable diagnostic station by the application, can attend later walk-in tests, and can securely view their reports when released. Administrators can monitor every part of the event in real time and reconcile sponsor-funded tests and employee-paid add-ons.

### Important reliability principle

The application is an operational workflow and record-keeping tool. It is **not** a clinical decision-support system. It must not decide which test is medically appropriate, interpret test results, or alter clinical orders. The Lab Partner must configure and approve the package contents, test dependencies, fasting requirements, station capabilities, and operational sequencing rules.

---

## 2. Required technical direction

The intended hosting direction is:

- **Application hosting:** Render.
- **Database/authentication/realtime/file storage:** Supabase (PostgreSQL, Supabase Auth, Realtime, and private Storage buckets where appropriate).
- **Application access:** A secure web link for staff/admins and a mobile-friendly participant portal opened by scanning the participant's QR code.

### Implementation instruction: inspect before choosing

Before changing code, inspect the existing repository and report:

- Framework, language, package manager, current routes/pages, and build commands.
- Existing Supabase configuration and schema/migrations.
- Existing authentication, UI components, styling system, and deployment configuration.
- Existing tests and coding conventions.

**Preserve the existing project architecture where it is sound.** Do not replace the framework, rewrite working modules, or introduce a second competing architecture without a demonstrated reason. If the repository is empty, choose a maintainable full-stack approach compatible with Render and Supabase and document the choice.

### Architectural requirements

1. PostgreSQL is the source of truth for registrations, test orders, queue assignments, completion states, payments, and reports.
2. Use database constraints and transactional server-side operations for critical state changes. Do not rely on browser state or client-side calculations to protect business rules.
3. Use Supabase Realtime for live dashboards/participant status where available, with a safe refresh or polling fallback. Realtime messages are notifications of a database change, not the authoritative record.
4. Keep privileged Supabase service-role credentials on the server only. Never ship them to a browser, mobile client, public JavaScript bundle, or QR code.
5. Use Supabase Row Level Security (RLS) and server-side authorization. Every relevant query and mutation must be scoped to the correct event and the user's permissions.
6. Use version-controlled database migrations. Do not rely on undocumented manual edits in the Supabase dashboard.
7. Keep payment, SMS/WhatsApp, LIS/lab-report, and printer integrations behind clearly defined adapters/interfaces. Do not pretend an integration exists until credentials, APIs, and a successful end-to-end test are available.
8. Use environment variables for secrets and environment-specific settings. Provide an `.env.example` with names and descriptions, never real secrets.
9. Support staging and production environments. Do not test with real patient data in development.
10. Add structured, privacy-safe logs, monitoring, error handling, and an admin-visible system/connection status.

### Greenfield project bootstrap (the starting folder may be empty)

The expected handoff may be a brand-new, empty project folder containing only `CLAUDE.md` and `UI_UX_DESIGN.md`. Handle both cases explicitly:

- If source code already exists, inspect and preserve the working architecture as described above.
- If the folder is empty or contains only these requirement files, treat this as a **greenfield build**. Do not ask the user to provide an existing repository, routes, components, migrations, or package manager files.
- Use a maintainable TypeScript-first web application compatible with Render and Supabase. Preferred starting stack when no existing stack is present: Next.js App Router, TypeScript, Tailwind CSS, a consistent accessible component system (for example shadcn/ui built on Radix primitives), Supabase SSR/client libraries, Zod for server/input validation, and Playwright plus unit/integration testing tools. Verify current stable versions and compatibility when implementing; do not blindly pin outdated versions.
- Use Supabase PostgreSQL migrations as the schema source of truth. Generate and maintain typed database interfaces/types. Put queue allocation and other critical transitions in server-side code and/or database functions/transactions, never only in client components.
- Scaffold the complete application foundation: routes/layouts, auth, event scoping, RBAC, migrations, environment validation, design tokens, shared components, tests, and Render deployment configuration.
- Create at least `README.md`, `.env.example`, migration scripts, seed/demo data scripts that use synthetic data only, and a deployment/runbook document. Never create fake production credentials or commit secrets.
- If no Supabase project credentials are available, build the application with a safe local/test configuration and clearly list the exact environment variables needed. Do not claim the hosted database, auth, realtime, storage, printer, payment, SMS, or LIS integration works until it has been connected and tested.
- Do not stop after producing an architecture plan or blank scaffold. After the plan is recorded, continue implementing the application in the phases below unless a genuinely blocking external credential/business approval is required. A missing integration credential must not prevent building its adapter boundary, mock-free configuration UI, or testable local contract.

---

## 3. Core terminology

Use these terms consistently in code, database names, UI labels, and documentation:

- **Event:** One particular Bank of India employee health camp.
- **Participant:** The employee attending the camp. The UI may also use “Employee” or “Patient” where appropriate.
- **Registration:** The participant's unique entry for this event.
- **Package:** One of the two sponsor-funded packages configured for this event: Male or Female.
- **Test:** A diagnostic service, such as blood collection, ECG, or X-ray. The final test catalogue comes from the Lab Partner.
- **Package test:** A test included in the participant's selected sponsored package.
- **Add-on test:** A test not included in that package and paid for by the participant.
- **Station:** A physical counter/room/team where one or more configured test types can be performed.
- **Queue assignment:** The participant's current instruction to attend a compatible station for a particular test.
- **Walk-in centre:** A designated centre where selected tests can be performed outside the main event venue.
- **Report:** A result document or report record associated with the participant and one or more tests.
- **Sponsor-funded:** A package test for which the employee is not charged. Record participant-level and test-level attendance so authorized backend reconciliation can be performed. Sponsor rates and sponsor settlement amounts are never displayed in application screens or ordinary exports.

---

## 4. User roles and permissions

Implement role-based access control (RBAC). Permissions must be enforced on the server/database, not merely by hiding buttons in the UI. An event may have multiple users in the same role.

### Suggested roles

| Role                         | Main permissions                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform/Super Admin         | Manage application-level configuration and create/manage events and event administrators. Access across events only when explicitly authorized.                                                                                                                                                                                                                           |
| Event Admin                  | Configure event, the two package definitions and their test lists, test catalogue, add-on prices, event-day/walk-in routing, station types/capacities, counters, staff, shifts, scheduling policies, and permissions; view operational dashboards and reports; perform approved corrections. Sponsor settlement rates remain backend-only and are not rendered in the UI. |
| Registration Supervisor      | Monitor registration counters, assign staff/counters within granted permissions, resolve duplicate or incorrect registrations, and view registration summaries.                                                                                                                                                                                                           |
| Registration Staff           | Search for duplicates, enter the event's Male/Female classification, confirm the automatically mapped package, register participants, print/reprint a tag, and view permitted participant registration details. Cannot edit package definitions, package test lists, sponsor rates, or global configuration unless explicitly granted a separate permission.              |
| Add-on Desk Staff            | Search/scan a participant, explain and add configured add-on tests, create payment requests/records, and view the payment state. Cannot mark a payment verified unless separately granted that permission.                                                                                                                                                                |
| Payment Verifier/Cashier     | Verify supported payment evidence, record transaction references, issue/reprint receipts, and process authorized refunds/voids. Separate from add-on order creation where operationally practical.                                                                                                                                                                        |
| Station Supervisor           | View station workloads, open/pause/close stations, assign station staff, and manage station queues within permission.                                                                                                                                                                                                                                                     |
| Station Technician/Staff     | Scan a participant, see only the tests relevant to that station, start/complete/mark an exception for an authorized task, and view the minimum data needed to perform the work. May edit operational records only within explicitly granted permissions; must not directly rewrite the test catalogue or package definitions by default.                                  |
| Walk-in Centre Staff         | Find/scan a participant, record the centre visit and attendance, and update only the tests assigned to that centre.                                                                                                                                                                                                                                                       |
| Report Manager/Lab Staff     | Upload/import reports, associate them with the correct participant/test, validate, publish, replace, or withdraw reports according to permission.                                                                                                                                                                                                                         |
| Finance/Audit Viewer         | Read approved revenue, sponsor reconciliation, payment, and event summary reports; no operational edits by default.                                                                                                                                                                                                                                                       |
| Bank of India/Sponsor Viewer | Optional restricted read-only view of agreed sponsor-level totals and reconciliation data. No access to clinical reports or unnecessary personal/medical details.                                                                                                                                                                                                         |
| Participant                  | View only their own registration, their test progress, payment/receipt details appropriate to them, and their published reports. No staff/admin functionality.                                                                                                                                                                                                            |

### Permission design

- Define granular permissions such as `registration.create`, `registration.correct`, `tag.reprint`, `addon.create`, `payment.verify`, `payment.refund`, `station.configure`, `queue.override`, `task.complete`, `walkin.checkin`, `report.upload`, `report.publish`, `report.withdraw`, `finance.view`, and `audit.view`.
- Event Admin can assign permissions to roles or individual staff, with an audit trail.
- Staff must have an assigned event and, where relevant, an active counter/station and shift before performing operational actions.
- Prevent an unassigned or expired-shift user from making station/counter updates unless the user has an explicit supervisory override.
- Record who performed every consequential action, when, from which event/counter/station, and (where appropriate) the reason.
- Never give all staff unrestricted admin access for convenience.

---

## 5. Event setup and administration

The Event Admin must be able to configure the event without a code change.

### 5.1 Event profile

Fields should include:

- Event name and internal event code.
- Sponsor name (Bank of India for this event).
- Lab Partner display/legal name (confirm before launch).
- Event date(s), start/end time, timezone, venue and contact/help information.
- Registration opening/closing times and operational status (`draft`, `ready`, `live`, `paused`, `closed`, `archived`).
- Expected attendance (initial planning estimate: 400–500; configurable).
- Participant portal branding and support instructions.

### 5.2 Packages and tests

The admin configures the two package definitions. Do not hard-code package names or package test contents.

For each package, store:

- Package code/name and description.
- Eligibility rule supplied by the Lab Partner (for example, the intended male/female package mapping). Do not infer eligibility from a participant's name.
- Active dates/status.
- Included test items, quantities if relevant, and whether each test is performed at the event venue or at a walk-in centre.
- Lab-approved sequencing/dependency rules, fasting requirement flag, operational priority, estimated service duration if supplied, and any time/location restriction.
- Sponsor-funded backend rate/reference for reconciliation. For this event, the client supplied ₹2,999 (Female) and ₹1,999 (Male). Keep these in server-restricted storage and never display them in the application UI or ordinary exports.

### Brochure-based package configuration supplied by the client (10 November 2026)

The client supplied a photograph of the package brochure and confirmed: **the underlined package item(s) are performed at the walk-in centre; every other listed package test is performed at the main event venue on the camp day.** These are the initial pre-built package templates. The Event Admin must be able to edit test names/codes, package mappings, active status, execution location, and station mapping through the admin panel without a code change. Staff can make only those changes for which the Admin has explicitly granted a granular permission; ordinary operational staff cannot edit the master catalogue by default.

| Package classification | Package name                        | Sponsor reference rate (backend only; never display in UI) | Main-event-day package items                                                                                                                                          | Walk-in-centre package item(s)                                                                                                                                                          |
| ---------------------- | ----------------------------------- | ---------------------------------------------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Female                 | Exclusive Wellness Package (Female) |                                                     ₹2,999 | CBC; T3; T4; TSH; LFT; **B2, BT2** (preserve both client-provided labels; do not expand or reinterpret); D; CA-125; Calcium; Lipid; HbA1c; BMD; ECG; Body Composition | USG screening choice group: Thyroid **or** Breast (initial configurable interpretation; admin can configure a single choice, multiple choices, or a bundled service after confirmation) |
| Male                   | Exclusive Wellness Package (Male)   |                                                     ₹1,999 | CBC; TFT; LFT; **B2, BT2** (preserve both client-provided labels; do not expand or reinterpret); D; PSA; Calcium; HbA1c; Lipid; BMD; ECG; X-Ray; Body Composition     | USG screening – Thyroid                                                                                                                                                                 |

**Confirmed commercial and display rules:**

1. The two brochure rates are the amounts Bank of India pays the Lab Partner for the respective sponsored package, as stated by the client. Store them only in a restricted backend configuration/settlement record. Do not render the rates, package payable amounts, or sponsor settlement totals in the participant portal, staff screens, ordinary admin UI, dashboards, barcode/QR labels, or ordinary exports. The employee-facing sponsored package charge is always ₹0.
2. The software must capture the evidence needed to reconcile sponsor billing: registered participants by package, participants who actually appeared, and a distinct attendance record for each package test/service. A registration by itself is not proof of attendance. Scans/retries must not inflate counts. Store both unique package-level attendance and per-test attendance/completion counts. Do not expose sponsor money values in the UI. Do not finalize any backend payable calculation until the Lab Partner confirms whether the package rate is applied per unique participant who appears for the package, per test attendance, or under another signed-off rule. The attendance ledger must preserve the raw records so the agreed formula can be applied without reconstructing the event after the fact.
3. The employee pays ₹0 for all tests included in the selected Male/Female package. Only tests outside that participant's package are add-ons and may carry an employee-facing price. Keep add-on revenue and sponsor-funded package attendance logically and financially separate.
4. The underlined USG item(s) are walk-in-centre services. All other listed package items are event-day services. Registration must create separate event-day and walk-in task groups; the event-day queue scheduler must never send a walk-in task to a main-event diagnostic station.
5. The female brochure text `USG screening – Thyroid/Breast` is represented as a configurable choice group with two options (`Thyroid`, `Breast`). The provisional default is **choose one option**, because the client believes the participant can choose between the two. Do not create two completed test obligations automatically. The admin configuration must support changing the group to one-of, one-or-more, or one bundled service after confirmation. Record which option was selected and retain the parent package-service link for reporting.
6. The male walk-in item remains `USG screening – Thyroid` as a single initial service. Both packages use the brochure's walk-in centre label `Taiyo Labs Center`; confirm the exact display/legal name, address, contact details, operating days/hours, appointment requirement, validity period, and whether the participant needs an appointment before enabling directions.
7. Preserve the brochure/client shorthand as supplied: `B2`, `BT2`, and `D`. Do not infer Vitamin B12, Vitamin D, or any other clinical meaning. The Admin may edit the display label and stable code after receiving the Lab Partner's approved catalogue. Keep the original brochure string as source/audit metadata.
8. The female brochure lists `T3`, `T4`, and `TSH` separately; the male brochure lists `TFT`. Keep these separate as prebuilt catalogue items unless an authorized Admin updates the configuration based on the Lab Partner's approved order codes. Do not silently normalize or merge them.
9. The two event package classifications are exactly `Female` and `Male`. The registration screen must capture this classification explicitly and automatically select the corresponding package based on the configured mapping. Do not infer it from the participant's name. Do not let a registration select a mismatched package without an explicitly permissioned, audited supervisor override.
10. These package lists are editable operational configuration, not permanent constants in source code. Each registration must store a snapshot/version of the package and test list used at registration so later admin edits do not rewrite historical orders or attendance.

### Test order lines versus queueable service visits (important workflow distinction)

Do not assume that every named package test requires a separate physical station visit or a separate queue ticket. A package may contain many individual diagnostic/test order lines that are fulfilled during one operational encounter. For example, several lab tests may be covered by one blood-sample collection visit, while ECG, X-Ray, BMD, and Body Composition may each require their own configured station visit. This is an example of the required modelling capability, not a final clinical grouping; the Lab Partner must approve the exact mapping.

Model these as two related but distinct concepts:

- **Package test/order line:** the individual service/test included in the package or added by the participant. It remains independently trackable for package contents, attendance evidence, reporting/accession mapping, and reconciliation.
- **Workflow service/encounter:** the physical visit or operational task that a participant queues for at a station or centre. One workflow service may fulfil one or more package test/order lines when the Lab Partner confirms they are performed together.

Requirements:

1. Provide admin-editable workflow service groups (for example, a configured blood collection encounter) and a many-to-many or otherwise explicit mapping to package test/order lines.
2. Generate queue tickets and next-step assignments for workflow service encounters, not one separate queue ticket per lab analyte when those tests are collected in the same visit.
3. Preserve the underlying test/order lines. A grouped station visit must not collapse test identity, report mapping, or per-test attendance/reconciliation evidence.
4. When a service encounter is completed, create attendance evidence for the associated test lines only according to the Lab Partner-approved completion rule. Do not automatically mark a test attended merely because another grouped service was completed unless the configured mapping explicitly says it was fulfilled.
5. Keep sample collection/service completion distinct from lab processing and report publication. A sample collected at the event does not mean the final report is already available.
6. Allow different groupings by package, location, station type, event, and configuration version. Existing participant orders retain the grouping snapshot used at registration.
7. Validate that every required package test/order line maps to an appropriate workflow service or has an explicitly approved standalone workflow before the event can go live.
8. The participant portal should show a clear physical next step (for example, “Blood sample collection — Station B-03”) while still listing the included test names/progress in the detailed package section.

This distinction is essential for correct queue lengths, station capacity planning, participant guidance, and per-test attendance evidence. Do not hard-code all blood tests into a single group until the Lab Partner confirms the exact collection grouping and any exceptions.

### Admin-editable test catalogue and package configuration

Build the following master-data screens and server-side operations:

- Create, view, edit, activate/deactivate, and archive test catalogue entries. Each entry has a stable internal ID, test code, display name, category, source/original wording, optional Lab Partner order code, operational instructions, execution location (`event_day` or `walk_in`), supported station type(s), active state, and add-on availability/pricing metadata.
- Edit the Male and Female package definitions and their included test/service mappings. For this event, enforce exactly two package categories; administrators edit the contents rather than adding a third package category.
- Add/remove a test from a package for future registrations; edit its location, choice-group/bundle behaviour, required/optional state, station compatibility, and approved sequence/dependency rules.
- Configure choice groups such as the female USG selection (`Thyroid` / `Breast`), including selection rule, available options, and whether each option creates a separate child task.
- Assign tests to station types and locations. Validate that every event-day test has at least one compatible active event station and every walk-in item has an active walk-in centre.
- Provide a preview of the package task plan before saving. Show warnings for missing station mappings, inactive tests, duplicate mappings, unresolved choice groups, or missing walk-in configuration.
- Require a reason for changing a live event's package/test configuration. Version all changes and apply them to new registrations by default. Existing participant orders are changed only through a dedicated authorized correction/migration workflow with an audit trail.
- Granularly separate `catalogue.view`, `catalogue.edit`, `package.view`, `package.edit`, `package.test_mapping.edit`, `station.mapping.edit`, and `live_configuration.override` permissions. Staff can be granted selected edit permissions, but do not grant them by default.

### 5.3 Add-on pricing

For each add-on test, the admin configures:

- Test code and display name.
- Price, currency (INR for this event unless confirmed otherwise), and applicable tax/fee configuration supplied by the finance team.
- Effective start/end date and active status.
- Whether it is available at the event venue, a walk-in centre, or both.
- Whether payment must be verified before the task can be queued/performed.
- Any discount/waiver policy, which must be permission-controlled and audited.

Changing a price must not silently change an already-created add-on order. Save the price applied to each order item as a snapshot.

### 5.4 Registration counters, stations, and shifts

The admin can create, edit, activate, pause, and close:

- Multiple registration counters.
- One or more add-on/payment desks.
- Multiple stations for the same station type (for example, five independent blood sample collection stations).
- ECG, X-ray, and other station types required by the actual test catalogue.
- Walk-in centres/locations.

For each counter/station, configure:

- Name/code, type, event/location, supported test types, and status.
- Capacity or service-rate settings if known; otherwise allow a safe default and make it adjustable.
- Assigned staff, supervisor, and shift start/end times.
- Whether it can accept new queue assignments.
- Optional maximum queue/target wait and pause reason.

A staff member can be assigned to a particular counter/station and shift. The system must support staff changes between shifts without losing historical assignments or task attribution. Do not overwrite earlier shift records.

A station that is paused, closed, outside its active shift, or not staffed must not receive new work unless a supervisor explicitly overrides the condition.

### 5.5 Configuration safety

- Validate that every package test has an execution location and a compatible station/centre before the event can be marked `ready`.
- Warn when a test has no compatible active station, a station has no staff, a package has no tests, prices are missing, or a required route is impossible.
- Once the event is live, important configuration changes must be versioned and audited. Do not silently rewrite historical registrations or completed tasks.
- A configuration change should affect new orders by default. Existing registrations should change only through an explicit, audited migration/correction action.

---

## 6. Participant registration and barcode/QR tag

### 6.1 Registration flow

1. Staff signs in and selects their assigned event/counter/active shift.
2. Staff searches for a possible existing registration using the approved identifiers (for example, employee ID or mobile number). Show possible duplicates before creating a new registration.
3. Staff enters the required details, explicitly selects the event's classification (`Female` or `Male`), and the software automatically maps it to the matching sponsored package. Show the mapped package for confirmation before saving.
4. The server validates the classification/package mapping, creates the registration, snapshots the package/test configuration, creates event-day and walk-in package tasks (including unresolved choice groups where applicable), and reserves a package-specific unique registration code in one safe transaction.
5. The system creates a tag containing a machine-readable code and human-readable participant information, then opens the print flow.
6. Registration staff confirms that the tag was printed and attached to the correct participant. Print failure must not lose or duplicate the registration.
7. The participant portal must immediately show the registration and current next-step status after the transaction commits.

### 6.2 Participant data

Collect only the information the Lab Partner confirms is required. Likely fields to confirm include:

- Full name.
- Age or date of birth (prefer date of birth only if genuinely needed; otherwise store age as captured with an as-of date).
- Package selection and the source of eligibility confirmation.
- Employee ID or another approved unique employee identifier, if supplied/required.
- Mobile number for OTP/notifications, if required and consented to.
- Optional email/department/other fields only if the client confirms a genuine operational requirement.

Do not invent additional medical fields. Add consent and privacy-notice acknowledgement fields as approved by the client. Store creation time, created-by user, event, and registration counter.

### 6.3 Unique code and duplicate protection

- Generate a unique, human-readable registration code with a package-specific prefix. Suggested initial formats: `BOI-F-2026-000001` for the Female package and `BOI-M-2026-000001` for the Male package. The event code/year/prefix/format must be configurable by the Event Admin.
- Maintain separate counters per event and package classification, so the code itself clearly classifies the registration as Female or Male. Search must work by the complete code and by its exact participant record.
- Enforce uniqueness in the database, not only in the frontend. Use a transaction-safe sequence/counter scoped to event + package; parallel registration counters must never issue the same code.
- Create the registration and initial order/tasks idempotently. A browser retry must not create another registration.
- Provide an explicit duplicate-resolution workflow for supervisors. Never silently merge participants or delete a registration.

### 6.4 Barcode/QR design and privacy

The original business request proposes putting the participant's name, age, package, and unique code inside the barcode. **Do not encode personal information or medical/package details directly in a publicly scannable QR/barcode.** A printed tag may visibly display approved human-readable details, but the machine-readable value must be a random, unguessable opaque token or a secure URL containing such a token.

Recommended design:

- Print a **Code 128 barcode** for the internal registration code if compatible with the chosen scanner/printer workflow.
- Print a **QR code** that opens the participant portal through a high-entropy, random, revocable token.
- The staff scanner workflow requires an authenticated staff session and resolves the code/token server-side. Knowing a registration number alone must not grant staff access.
- The participant QR can identify the registration, but access to clinical reports must require an additional appropriate verification step (for example, OTP to the verified participant mobile number, or another client-approved strong access method). A lost tag must be revocable and replaceable.
- Store only a hash of the portal token where practical; compare securely on the server. Do not log the full token.
- Support token rotation/revocation and audited tag reprints.
- The tag's visible text can include the participant name, age if approved, package name, and registration code, subject to the Lab Partner's privacy approval. Do not expose a report or detailed medical information on the tag.

### 6.5 Printing

- Provide a clear print preview and a configurable tag/label template.
- Support browser printing and, if required by the chosen hardware, a generated print-ready PDF or a tested printer integration.
- Configure paper/label dimensions, orientation, margins, barcode/QR size, and readable font size.
- Include a “test print” function before event day.
- Record original print and every reprint with user, timestamp, reason (where required), and tag version.
- A printing failure must leave the registration intact and allow a controlled reprint.
- Test with the actual printer, scanner, operating system, browser, label stock, and network planned for the event. Do not claim hardware compatibility based only on a browser preview.

---

## 7. Add-on tests and employee payments

### 7.1 Add-on desk workflow

1. Add-on staff signs in to an assigned add-on desk/shift.
2. Staff scans the participant tag or searches by registration code/name and verifies the participant before editing.
3. The screen displays the participant's selected package and its included tests, clearly distinguished from add-on tests.
4. Staff searches the configured active test catalogue and selects only tests that are add-ons for that participant's package.
5. The participant is shown the test name, price, and total before confirming. Capture the required consent/confirmation.
6. Create an add-on order item and payment record with an immutable price snapshot.
7. The system displays the payment method/instructions supported for this event. Do not add a payment method that has not been confirmed and tested.
8. After payment has been verified, the paid add-on task becomes eligible for the queue according to its station/location rules. If payment is pending, clearly show `payment pending` and do not accidentally treat it as paid.
9. Issue a receipt or transaction acknowledgement with a unique reference.

### 7.2 Payment state model

At minimum support:

- `not_required` — only for sponsor-funded package tests.
- `pending` — payment initiated or evidence awaiting verification.
- `paid` — verified payment.
- `failed` — verified failure.
- `cancelled` — order/payment cancelled before completion.
- `partially_refunded` and `refunded` — where refunds are supported.
- `requires_review` — mismatch, duplicate reference, or uncertain evidence.

Do not equate “QR displayed”, “UPI app opened”, or a participant screenshot with confirmed payment. The business must choose how confirmation happens:

- A gateway/provider integration with a trusted server-side callback/webhook; or
- A controlled manual verification process by an authorized cashier using the provider's settlement/transaction evidence.

Do not collect UPI PINs, card PINs, passwords, or other payment credentials. Never store sensitive payment credentials.

### 7.3 Payment correctness

- Use idempotency keys to prevent duplicate payment creation or duplicate order updates on retries.
- Verify webhook signatures and event identity when a provider is integrated.
- Store provider transaction/reference IDs uniquely where appropriate.
- Preserve each payment attempt and its result; do not overwrite payment history.
- Refunds, cancellations, discounts, price overrides, and manual paid-status corrections require permission and an audit reason.
- Do not permit an add-on task to be performed while its payment is pending unless an explicit admin policy permits it and records an approved exception.
- Sponsor-funded package tests must not generate an employee payable amount. Sponsor reconciliation is a separate report from employee add-on revenue.

---

## 8. Automatic queueing and station workflow

This is the central operational feature. It must be implemented as a deterministic, transaction-safe server-side scheduler, with a transparent explanation of why a station was selected.

### 8.1 Required behaviour

- Multiple stations may perform the same test type (for example, five blood collection stations).
- Each station has its own staff, shift, status, compatible tests, and current queue.
- A participant must be guided to one clear next action at a time by default. Do not give a participant multiple conflicting station instructions.
- At registration, the system assigns the participant's first eligible on-site task to the most suitable available station according to the configured event policy.
- When the current task is marked complete, the system calculates the participant's next eligible task and assigns it to the best compatible station.
- The participant can scan their QR tag at any point to see their own progress, current assignment, location/station instructions, and remaining tests.
- Station staff can scan the participant's tag to retrieve the relevant task and update its status.
- A task must not be marked complete merely because the participant scanned the tag. Completion requires an explicit authorized staff action.

### 8.2 Do not choose an incompatible station

The “least crowded station” must be chosen only from stations that can actually perform the selected test. An ECG station cannot be selected for a blood collection task, and an X-ray station cannot be selected for an ECG task. For a test supported by several stations, the scheduler chooses among those compatible stations.

### 8.3 Recommended scheduling algorithm

Implement a configurable scheduling policy. The safe default is:

1. Load the participant's unfinished tasks and the approved package/add-on workflow rules.
2. Filter to tasks that are currently eligible: not completed/cancelled, payment condition satisfied, dependencies satisfied, location available, and any Lab Partner-defined time/fasting condition satisfied.
3. Respect configured mandatory order, operational priority, and time-window rules. For example, a fasting-required blood collection task may have a configured priority before other activities. This rule must be supplied/approved by the Lab Partner; do not invent clinical priorities.
4. Find active, staffed, open stations compatible with each eligible task.
5. Estimate the queue load for each compatible station using at least waiting tasks, in-service tasks, currently active staff/capacity, and (if configured) expected service duration. A simple count of people physically near a station is not sufficient when actual queue data is available.
6. Select the eligible task/station combination with the lowest configured expected-wait/load score, subject to priority and dependencies.
7. Use a deterministic tie-breaker such as round-robin or oldest-last-assigned to distribute work evenly.
8. Atomically reserve the queue assignment in the database and update the participant's current next step. Re-check station availability/capacity inside the transaction to prevent two simultaneous registrations from overfilling or incorrectly selecting the same station.
9. Record the scheduler decision inputs and reason (for example, “lowest estimated wait among compatible active ECG stations”) for troubleshooting and audit.

If no compatible station is available, set the task to `waiting_unassigned`/`on_hold`, show a clear status, and alert the relevant supervisor. Never silently assign an unavailable station.

### 8.4 One active assignment by default

By default, a participant can have only **one active station assignment** at a time. This avoids sending the same person to multiple queues simultaneously and makes the next action unambiguous. The Lab Partner may later approve parallel task routing, but it must be an explicit event setting and thoroughly tested before use.

### 8.5 Queue state model

Use explicit states, such as:

- `not_ready` — task exists but dependencies/payment/location/time conditions are not yet satisfied.
- `waiting_unassigned` — eligible but no compatible staffed station is currently available.
- `queued` — assigned to a station and waiting.
- `called` — station has called the participant.
- `in_service` — service has started.
- `completed` — authorized staff confirmed the task is complete.
- `no_show` — participant did not attend after the configured handling procedure.
- `skipped` — explicitly skipped with a reason and appropriate permission.
- `cancelled` — task cancelled with a reason and appropriate permission.
- `exception` — issue requires supervisor resolution.

Do not use a single ambiguous boolean such as `is_done` to represent the full workflow.

### 8.6 Station workflow

1. Staff signs in and enters the assigned station/shift.
2. Station dashboard shows the station's current queue, next participant, in-service task, and completed count.
3. Staff scans a participant's tag or selects the next queue entry.
4. Server validates that the task belongs to this participant, is assigned to this station, is in the correct state, and that the staff member is authorized.
5. Staff starts the task (`in_service`) and completes it (`completed`) after the actual station work is finished.
6. On completion, a transaction closes the active assignment, records who completed it and when, updates the participant's progress, and asks the scheduler to allocate the next eligible task.
7. The new assignment becomes visible on the staff and participant dashboards.

Support a controlled “call next” action, but do not let it bypass task eligibility or assign two active tickets to the same participant.

### 8.7 Rebalancing, pauses, and exceptions

- Do not move a participant who is already `in_service` automatically.
- Waiting participants may be moved to another compatible station only through a safe reallocation transaction and with an audit record.
- When a station closes or pauses, stop new assignments immediately. Reassign waiting tickets only after checking compatibility and informing the participant/staff UI.
- Supervisors can handle no-shows, participant requests, equipment downtime, incorrect scans, and exceptional routing with a mandatory reason.
- Prevent duplicate scans, repeated taps, or browser retries from completing a task twice or creating multiple queue tickets.
- Provide a manual fallback procedure for a network or hardware outage. Reconciliation of manual records must be controlled, attributable, and duplicate-safe.

### 8.8 Live queue and participant views

**Staff station view:** current queue, queue position, next participant, task type, in-service timer if useful, completed count, station status, assigned staff, and exception controls.

**Participant portal:**

- Registration code and confirmed package.
- Current status in plain language.
- “Your next step” with station name, location/instructions, and current queue state.
- Completed tests.
- Remaining package tests and add-on tests, clearly separated.
- Walk-in-centre tasks and location/instructions.
- Payment state and receipt for add-ons.
- Report availability state for each test/report.
- Event support/contact details.

Participant pages must show only that participant's own information. Do not expose a public list of names or other participants' medical/test details.

---

## 9. Walk-in centre tracking

Some tests included in the sponsored package are not performed at the main event venue. The application must track attendance and completion at the designated walk-in centre(s).

For the current brochure-based configuration, the provisional walk-in tasks are:

- Female package: a `USG screening` choice group at the Taiyo Labs Center, with `Thyroid` and `Breast` as the two options. Default the choice rule to one option selected by the participant; allow the Admin to change it to multiple options or a bundled service after confirmation.
- Male package: `USG screening – Thyroid` at the Taiyo Labs Center.

All other brochure-listed tests in those packages are event-day tasks. These are initial client-supplied routing instructions and must be confirmed by the Lab Partner. Do not route walk-in tasks into the camp-day queues. Do not mark the female USG choice group as complete until the configured required choice has been selected and its service task has been completed. Do not consider a participant's overall package complete while required walk-in items remain outstanding; show event-day, walk-in, and overall package progress separately.

### Workflow

1. A participant visits the designated walk-in centre on an allowed date/time.
2. Walk-in staff signs in, selects their assigned centre/shift, and scans the tag or searches the registration code.
3. The system displays only the participant's eligible walk-in tasks and relevant instructions.
4. Staff selects the test being attended and records arrival/check-in.
5. The centre performs the test and staff records the appropriate status, including completion only after the service is actually performed.
6. The visit record stores centre, date/time, test, operator, and any approved external accession/reference number.
7. Participant progress and admin dashboards update.

### Walk-in requirements

- Support more than one visit for a participant where the package requires different centre visits.
- Distinguish `not attended`, `checked in`, `in service`, `completed`, `no show`, `cancelled`, and `exception`.
- Do not mark every walk-in test complete simply because a participant checked in for one test.
- Prevent an unconfigured or ineligible test from being completed at the walk-in centre.
- Allow authorized correction with an audit reason.
- Display the walk-in centre address/instructions and allowed date range supplied by the Lab Partner.
- If an external LIS/accession number is needed, store it against the relevant task/order item, not as an unstructured note only.

---

## 10. Reports and participant report portal

### 10.1 Report lifecycle

A report may move through states such as:

- `not_uploaded`
- `uploaded_pending_validation`
- `validated`
- `published`
- `replaced`
- `withdrawn`
- `upload_failed` / `requires_review`

Only a `published` report may be displayed/downloaded in the participant portal.

### 10.2 Upload/import workflow

The Lab Partner may supply reports manually or through an external laboratory information system (LIS/API). The actual method is **TO CONFIRM**. Build a safe adapter boundary so an integration can be added without redesigning the rest of the application.

For manual upload:

1. Authorized report staff searches/scans the participant and selects the appropriate test/order item.
2. The system validates the registration, event, test, and any accession/reference number.
3. Staff uploads the report file into a private storage bucket.
4. The system stores metadata, file checksum, uploader, upload time, report version, and status.
5. A second validation/publish step is available, preferably by a different authorized person for production use.
6. Once published, the participant portal reflects the updated status and allows secure viewing/downloading.

For LIS/API integration:

- Require the Lab Partner's API/webhook documentation, authentication method, mapping identifiers, test environment, and error/retry rules.
- Match records using a stable registration/order/accession identifier. Do not match reports by participant name alone.
- Verify webhook signatures or use authenticated polling/import.
- Make imports idempotent and retain unmatched/ambiguous reports in a review queue. Never guess the patient match.

### 10.3 File and access security

- Store reports in a **private** Supabase Storage bucket, not a public bucket.
- Never expose a permanent public storage URL.
- Authorize access server-side and generate short-lived signed URLs only after verifying participant identity/OTP or staff permission.
- Do not place report URLs or medical data in the QR code, email subject, browser logs, analytics events, or public notifications.
- Validate allowed file types and size. Consider malware scanning or a controlled file-processing pipeline before publication.
- Record report upload, validation, publication, replacement, withdrawal, and download events.
- Support corrected/replaced reports without deleting the audit history of the earlier version.
- Do not modify report content or interpret results in this application.

### 10.4 Participant report display

When the participant scans the QR code and passes the required identity verification:

- Show `Report not uploaded yet` (or equivalent) for a report not received from the Lab Partner.
- Show `Report processing` while validation is pending.
- Show `Report available` only when the report is published.
- If a report is withdrawn or replaced, do not show an obsolete version as current. Display an appropriate status and the latest published version.
- Keep a per-test report status as well as an overall report summary.

---

## 11. Admin dashboards, reporting, and reconciliation

The Event Admin dashboard should provide an operational view of the complete camp, with filters by event, date, package classification (Female/Male), counter, station, staff, task, location, and payment/report state where appropriate. The primary dashboard is a count-and-workflow control surface; never show sponsor package rates or sponsor payable totals.

### 11.1 Live event overview

Show at least:

- Total registrations and current arrival/check-in count.
- Registrations by package classification (`Female` / `Male`), with totals and percentage split.
- Registration activity by counter and staff/shift.
- A searchable participant/registration table with registration code, participant name, classification/package, registration time, arrival/appearance state, current/last station, event-day progress, walk-in progress, add-on count/payment state, and report state (only fields allowed for the viewer's role).
- Total package tests expected, participants appeared for each test, completed, pending, on hold, no-show, skipped, and exception counts, broken down by package/test/location.
- Current station status and active staff.
- Queue size/wait estimate by station and test type.
- Participants waiting unassigned due to unavailable capacity.
- On-site progress and walk-in-centre progress separately.
- Add-on orders, pending payments, verified payments, failed payments, refunds, and employee-paid add-on revenue. Never mix add-on revenue with sponsor-funded package records.
- Report counts: not uploaded, pending validation, published, replaced/withdrawn, and unmatched imports.
- Critical operational alerts (station offline, unstaffed station, payment mismatch, duplicate scan, report mapping issue, etc.).

### 11.2 Sponsor attendance/reconciliation records (no money shown in UI)

The client has stated that Bank of India pays the Lab Partner the Female/Male package rates shown in the brochure (Female ₹2,999; Male ₹1,999), and that settlement is based on participants who actually appear for the relevant tests. These rate values are backend-only. Do not show any sponsor rate, sponsor payable total, or package revenue amount in any application screen, participant/staff/admin dashboard, barcode/QR, or ordinary export.

The operational admin dashboard and role-controlled exports must show counts only:

- Registered participants per package classification (Female/Male).
- Unique participants who arrived/appeared for the event and unique participants with at least one recorded package-test attendance.
- For every package test/service: expected participants, appeared/attended participants, started, completed, pending, no-show, skipped, exception, and walk-in outstanding counts.
- Unique package-level attendance and per-test attendance, separately. A participant's repeated scan at the same test must not increase the count.
- Adjustments/exceptions with reason, actor, timestamp, and approval record.

Store the brochure sponsor rates in restricted backend configuration, not client-accessible package pricing fields. Capture immutable attendance events and snapshots so the sponsor's agreed settlement calculation can be reproduced later. The exact unit of settlement (one package fee per participant who appears, per-test attendance, or another contractual rule) must be represented as an explicit backend policy and signed off by the Lab Partner/Bank of India before any payable amount is calculated. Until that rule is approved, preserve the counts and do not calculate or expose a money total. Any future finance-only settlement output requires a separate explicit approval and permission design; it is outside the ordinary operational UI defined in this brief.

### 11.3 Add-on revenue report

Report separately:

- Add-on test/item, quantity, unit price snapshot, gross amount, discounts, tax/fee if applicable, paid amount, pending amount, failed amount, refund amount, and net received amount.
- Breakdown by payment method, cashier/desk, and time period.
- Payment transaction references and reconciliation status, with sensitive provider data masked.

Count **verified received payments**, not merely add-on orders, as revenue. Avoid double-counting a payment across retries or multiple order items.

### 11.4 Operational exports

Provide permission-controlled CSV/XLSX/PDF exports where useful, including participant manifest, station workload, test completion, walk-in pending list, add-on sales, payment reconciliation, sponsor reconciliation, and report status. Exports must be logged and must include only fields required for the recipient's role. Do not include clinical reports in ordinary operational exports.

---

## 12. User interface requirements

Build a fast, clear, low-friction interface suitable for a busy event with staff using desktop/tablet/mobile devices. Prefer large touch targets, obvious status labels, keyboard search, fast barcode scanning, and minimal navigation. The mandatory screen-by-screen layouts, visual system, navigation model, responsive rules, interaction patterns, and UI acceptance checklist are in `UI_UX_DESIGN.md`; implement both documents together.

### Required application areas

1. **Authentication and event selection** — staff login, event selection, assigned shift/counter/station context.
2. **Admin dashboard** — live overview, alerts, event configuration, staff/counter/station management, packages/tests, prices, permissions, reports/exports, audit log.
3. **Registration desk** — participant search/duplicate warning, registration form, package selection, create registration, print/reprint tag.
4. **Add-on desk** — scan/search, included-vs-add-on distinction, catalogue search, quote/confirm, payment status, receipt.
5. **Station dashboard** — station queue, scan participant, call/start/complete, exception handling, live status.
6. **Walk-in centre desk** — scan/search, eligible walk-in tasks, check-in, completion, visit history.
7. **Report management** — upload/import, mapping/validation queue, publish/replace/withdraw, report status.
8. **Participant portal** — responsive mobile page opened by QR, own progress, next instruction, add-on payment/receipt details, published reports after identity verification.
9. **Audit and finance views** — permission-restricted operational history, payments, sponsor reconciliation, add-on revenue.

### UI rules

- Clearly distinguish sponsored package tests from employee-paid add-ons everywhere.
- Use plain language, not only internal state codes.
- Make the next action prominent on participant and station views.
- Display timestamps in the event's local timezone.
- Make loading, empty, offline, error, pending, and success states explicit.
- Prevent accidental double submission by disabling/reconciling in-flight actions, while keeping server-side idempotency as the real safeguard.
- Provide search by registration code and approved participant identifiers. Name search should handle common spacing/case differences, but must not silently choose among similar names.
- Use responsive layouts and test the actual devices used at the event.
- Provide accessible labels, contrast, and keyboard operation for critical desk workflows.

---

## 13. Suggested data model

Claude Code must adapt names/relationships to the existing schema and framework, but the database must represent these concepts explicitly. Use UUID primary keys unless there is a strong existing convention. Keep the human-readable registration code separate from internal primary keys.

### Core/event configuration

- `events` — event profile, sponsor, lab partner, location, date/time, status, timezone, configuration version.
- `event_settings` — event-scoped operational and scheduling settings.
- `packages` — exactly two event/package definitions (Female and Male), eligibility/classification mapping, active dates/status, configuration version.
- `package_code_counters` — transaction-safe next-code counters scoped to event + package classification.
- `test_catalog` — canonical, admin-editable tests and operational attributes, preserving original brochure wording/source metadata.
- `package_tests` — individual test/order lines included in each package, execution location, choice-group configuration, priority, dependencies, fasting flag, and approved workflow settings.
- `workflow_services` — configurable queueable physical service/encounter definitions (for example, blood collection, ECG, X-Ray, or a walk-in USG visit).
- `workflow_service_tests` — explicit mapping from each workflow service/encounter to the package test/order lines it may fulfil, including configuration version and completion/attendance rules.
- `package_configuration_versions` — immutable package/test mapping snapshots referenced by registrations.
- `sponsor_backend_rates` or equivalent server-only configuration — backend-only package sponsor rates (Female ₹2,999; Male ₹1,999), never readable directly by browser clients or ordinary staff roles.
- `addon_prices` or versioned price records — event/test price and effective dates.
- `stations` — physical stations/counters/centres, status, capacity and location.
- `station_test_capabilities` — many-to-many mapping from station to supported test types.
- `staff_profiles` / user-role mapping — staff identity and account references.
- `event_memberships` — staff membership and event scope.
- `permissions` / role permissions — granular access.
- `staff_assignments` — staff, counter/station, shift, start/end, assignment status; retain history.

### Participant and orders

- `participants` — minimal participant identity/contact information, subject to confirmed requirements.
- `registrations` — event, participant, unique registration code, selected package, registration counter, status, created-by, timestamps, configuration snapshot/version.
- `registration_tokens` — hashed opaque portal/staff tag token, token type, expiry/revocation, created/reprinted metadata.
- `orders` — registration, order type/source, status, created-by, totals.
- `order_items` — test, package/add-on source, price snapshot, sponsor/employee responsibility, quantity, tax/discount snapshots, order state.
- `participant_tasks` — instantiated queueable workflow service/encounter tasks for a registration, linked to one or more underlying order/test lines, location, dependencies, eligibility, status, timestamps, and station/centre reference. Keep reportable/order-line records distinct from the queueable encounter.

### Queue and visits

- `queue_assignments` — participant task, station, queue number/sequence, state, assigned/called/started/completed times, scheduler reason/version, assigned-by (system or user).
- `station_events` — station open/pause/close and status history.
- `station_sessions` — station/shift/staff session information where useful.
- `walkin_centres` — configured centre locations.
- `walkin_visits` — participant, centre, visit date/time, staff, status.
- `task_status_history` — append-only status transition history with actor, reason, source, timestamp.
- `task_attendance_events` — immutable, deduplicated participant/test appearance records (arrived/appeared, started, completed, no-show/exception) used for accurate operational counts and backend sponsor reconciliation.
- `scan_events` — scan audit events; avoid unnecessary sensitive payload storage.

### Payments and receipts

- `payment_intents` — amount/currency, provider/method, status, idempotency key, order linkage.
- `payment_transactions` — provider/manual reference, amount, status, verified-by, verified-at, reconciliation metadata.
- `refunds` — amount, reason, actor, approval, provider reference/status.
- `receipts` — receipt reference and immutable transaction/order snapshot.

### Reports and audit

- `reports` — participant/task/order reference, report type, file storage key, checksum, version, lifecycle status, uploaded-by, validated-by, published-by, timestamps.
- `report_import_jobs` — external import status, matching key, failures, retry data, review state.
- `audit_logs` — actor, event, action, entity type/id, timestamp, reason, safe before/after metadata, request/correlation ID.
- `notifications` — in-app notification/outbox status if notifications are implemented.

### Database integrity expectations

- Unique constraint on `(event_id, registration_code)`.
- Unique or carefully constrained active queue assignment per participant/task and, by default, one active queue assignment per registration.
- Unique provider transaction IDs where supported.
- Foreign keys between registrations, events, participants, package/order items, tasks, stations, payments, and reports.
- Check constraints for valid states, non-negative amounts, valid quantities, and date/time ranges.
- Index event-scoped search and dashboard fields (registration code, participant search keys, task status, station/status, payment status, report status, timestamps).
- Preserve historical records. Use status changes and audit records rather than destructive deletion for consequential operational data.
- Use database transactions for registration creation, task creation, queue reservation, task completion/next assignment, and payment state transitions.

---

## 14. Security, privacy, and data protection

This system handles identifiable participants and diagnostic report files. Treat all participant, payment, and report data as sensitive.

Minimum safeguards:

- Enforce RLS and server-side authorization for every event-scoped table and Storage object.
- Test that one participant cannot access another participant's registration, payment details, or report by changing a URL, UUID, QR token, or request body.
- Test that staff from one event cannot access another event unless explicitly authorized.
- Require authenticated staff accounts; use strong password/session policies and MFA for admin/report/finance roles where supported and approved.
- Verify participant identity before exposing reports. A QR token alone should not be sufficient to access diagnostic documents.
- Keep report storage private and issue short-lived authorized download links only.
- Hash/revoke public portal tokens; do not log them in plaintext.
- Use HTTPS/TLS; protect secrets; rotate credentials; separate staging/production secrets.
- Minimize collected fields and define retention/deletion rules with the client.
- Do not put PII or report content into analytics, exception traces, URLs beyond the opaque token, or debug logs.
- Escape/sanitize user-supplied text and validate uploaded files.
- Rate-limit public token/OTP/search endpoints and protect against brute-force attempts.
- Use CSRF protection where relevant, secure cookies, safe CORS rules, and appropriate security headers.
- Maintain append-only audit trails for privileged changes and sensitive access.
- Define backup, restore, and incident-response procedures before the event.
- Obtain client approval for the privacy notice, consent language, access model, retention policy, and legal/compliance review applicable to the operating organizations and location. Do not claim legal compliance merely because these technical controls exist.

---

## 15. Reliability, concurrency, and event-day failure handling

The event must continue to be understandable and recoverable when a device, printer, scanner, station, or network connection fails.

### Critical transaction safety

- Registration creation and registration-code allocation must be atomic.
- Concurrent station assignment must use a database transaction/locking or equivalent mechanism to recheck station state and reserve capacity safely.
- Task completion and next-step allocation must be idempotent and atomic enough to prevent two active assignments.
- Payment webhooks/manual confirmations must be idempotent.
- Report import must be idempotent and must never attach the same report to the wrong participant.
- Use request idempotency keys for operations likely to be retried from a browser or device.
- Every state transition must validate the current state and allowed next state on the server.

### Connectivity and recovery

- Show a visible connection state to staff. If the server/database is unreachable, do not falsely show that registration, payment, task completion, or report publication succeeded.
- Retry safe reads. Retry writes only with the same idempotency key and after checking the server result.
- Do not create uncoordinated offline queue assignments on multiple devices. If full offline mode is not explicitly designed and tested, use a documented paper/manual fallback and reconcile it later through an authorized workflow.
- Keep a manual fallback sheet/process for registrations and station work. Define who can enter the fallback records and how duplicates are detected after connectivity returns.
- Provide a visible operational warning if Realtime disconnects; fall back to safe polling/refresh.
- Log integration failures and provide retry/reconciliation queues for payment/report imports.

### Backups and deployment

- Configure automated database backups and verify a restore process, not just backup existence.
- Run migrations in staging first and retain a rollback/recovery plan.
- Use health checks for the Render service and any critical background workers.
- Ensure event-critical functions do not depend on an unmonitored background worker unless a safe retry mechanism exists.

---

## 16. Performance and scale

The initial estimate is 400–500 participants, but multiple devices may be registering and scanning concurrently.

- Design for at least 500 registrations for one event and a realistic burst of concurrent desk/station activity. Validate the target concurrency with load tests rather than guessing.
- Avoid N+1 queries in dashboards and participant pages.
- Paginate large tables and use server-side filtering/search.
- Use database indexes for common event-scoped lookup and queue queries.
- Use efficient Realtime subscriptions; do not subscribe every participant to every event record.
- Keep barcode scan-to-result interaction fast on the venue network and target devices.
- Add a small operational status panel showing database/realtime connection state and recent failures.
- Do not cache private reports or participant records in a public/shared browser cache.

---

## 17. Testing and acceptance criteria

Do not declare the application production-ready because the pages render or a happy-path demo works. Implement automated tests and complete a full event-day rehearsal.

### 17.1 Unit and integration tests

Test at minimum:

- Package eligibility and package-test generation.
- Correct distinction between included package tests and add-on tests for each package.
- Female package generates the prebuilt event-day set (CBC, T3, T4, TSH, LFT, B2 / BT2, D, CA-125, Calcium, Lipid, HbA1c, BMD, ECG, Body Composition) and a separate walk-in USG choice group (Thyroid or Breast by default).
- Male package generates the prebuilt event-day set (CBC, TFT, LFT, B2 / BT2, D, PSA, Calcium, HbA1c, Lipid, BMD, ECG, X-Ray, Body Composition) and a separate walk-in USG screening – Thyroid task.
- Admin can edit test catalogue entries, package contents, location, choice-group rules, workflow-service grouping, and station mappings; staff can edit only with explicit granular permission. Existing registrations retain their original configuration snapshot.
- Multiple package test/order lines can be fulfilled by one approved physical service encounter (for example, a blood collection visit) without generating duplicate participant queue stops, while keeping per-test attendance and report associations distinct.
- Female/Male classification automatically maps to the respective package and produces a unique package-specific code prefix; concurrent registration must not duplicate codes.
- No walk-in-centre task is ever assigned to a main-event station; event-day tests are not incorrectly sent to the walk-in queue.
- Employee charge for either sponsored package is zero; sponsor rates ₹2,999 (Female) and ₹1,999 (Male) are stored backend-only and never exposed in application UI or ordinary exports.
- Attendance counts are deduplicated by participant and test, distinguishing registered from actually appeared/attended and completed; repeated scans cannot inflate sponsor reconciliation counts.
- Price snapshot behaviour when an admin later changes an add-on price.
- Unique registration-code generation under concurrent requests.
- Duplicate registration warnings and supervisor duplicate resolution.
- QR token generation, hashing, revocation, rotation, and authorization.
- RBAC for every role and permission-sensitive action.
- Station compatibility filtering (a station never receives an unsupported test).
- Queue score/load calculation, priority/dependency rules, deterministic tie-breaks, station pause/close behaviour, and no-capacity behaviour.
- Concurrent queue allocation does not over-assign station capacity or create multiple active participant assignments.
- Task state transitions reject illegal transitions and duplicate completion.
- Add-on payment pending/paid/failed/refunded flows and retry/idempotency behaviour.
- Sponsor package tests never create employee charges.
- Walk-in check-in is not mistaken for test completion.
- Report matching, unmatched report review, publish/withdraw/replace, and participant access controls.
- RLS and Storage access restrictions, including cross-participant and cross-event access attempts.
- Audit log generation for all consequential changes.

### 17.2 End-to-end scenarios

1. Register a participant at counter A, print a tag, and confirm their correct package and tasks appear.
2. Register participants concurrently at multiple counters and confirm no duplicate registration codes or duplicate participants caused by retries.
3. Scan a tag at a station and confirm only the matching participant/task is displayed.
4. Complete a blood collection task and confirm the next compatible, available station is allocated based on the configured scheduling policy.
5. Populate one ECG station more heavily than another and confirm new eligible ECG tasks are distributed to the lower-load compatible station.
6. Pause a station and confirm it receives no new assignments; safely handle its waiting queue.
7. Attempt to send an X-ray task to an ECG-only station and confirm the server rejects it.
8. Add an extra test, verify the displayed price, leave payment pending, and confirm the task is not treated as paid/eligible unless the approved policy explicitly says otherwise.
9. Confirm payment, retry the same callback/action, and verify the employee is charged only once.
10. Confirm a package-included test remains sponsor-funded and creates no employee payment.
11. Check in a participant at a walk-in centre, then verify check-in alone does not mark all centre tests completed.
12. Upload a report against the wrong registration/accession and verify it is rejected or held for review rather than published.
13. Publish a valid report and verify only the correct participant can access it after the required identity check.
14. Revoke a lost tag and verify the old QR no longer grants access.
15. Disconnect a device/network during a write and verify the UI does not falsely report success or create duplicates after retry.
16. Attempt unauthorized registration edits, payment verification, station changes, report publication, and cross-event access; verify denial and audit logging.
17. Reprint a tag and verify the reprint is audited and the old token policy is followed.

### 17.3 Load and resilience tests

- Simulate 500 registrations and realistic parallel station scans/updates.
- Simulate bursts of concurrent registrations at multiple counters.
- Simulate many participants being completed and re-queued at the same time.
- Simulate Realtime interruption and reconnection.
- Simulate payment/report provider retries and duplicate callbacks.
- Record response times, database errors, queue correctness, and duplicate counts.
- There must be zero duplicate registration codes, zero unauthorized report exposures, and zero incompatible station assignments in the test suite.

### 17.4 Event-day rehearsal

Before production:

- Configure the actual two packages and complete test catalogue.
- Configure the actual counters, stations, capacities, staff assignments, and shifts.
- Test with the real printer, labels, scanners, browsers, phones, and venue network.
- Run a rehearsal with representative users and synthetic participants.
- Test add-on payment confirmation with the real agreed payment method (or a clearly documented manual procedure).
- Test walk-in check-in and report upload/import with the Lab Partner's real process in a safe test environment.
- Verify every dashboard and export with the client.
- Train registration, cashier, station, walk-in, report, and admin staff.
- Print a manual fallback pack and document escalation contacts.
- Confirm database backup/restore, Render deployment rollback, and a named technical on-call contact for the event.

---

## 18. Definition of done

The project is ready for a production event only when all applicable items below are complete and signed off:

- [ ] Existing repository/architecture audited or greenfield project bootstrapped; implementation plan and architecture decisions documented.
- [ ] `UI_UX_DESIGN.md` has been implemented as real responsive screens and passed its UI/UX acceptance checklist.
- [ ] Event can be configured without code changes.
- [ ] Both packages and their exact tests/locations are loaded and verified by the Lab Partner.
- [ ] Add-on catalogue and prices are verified by the Lab Partner/finance owner.
- [ ] Registration works concurrently with unique codes and duplicate safeguards.
- [ ] QR/barcode tags print correctly on the actual hardware and can be scanned reliably.
- [ ] Staff accounts, RBAC, counters, stations, shifts, and permissions are verified.
- [ ] Queue allocation is compatible, fair, auditable, transaction-safe, and tested under concurrency.
- [ ] Station completion advances each participant to the correct next step.
- [ ] Walk-in centre attendance/completion tracking works.
- [ ] Payment method and payment-verification process are tested end-to-end.
- [ ] Sponsor-funded and employee-paid financial records are clearly separated and reconciled.
- [ ] Report upload/import, validation, publication, replacement, and participant access work securely.
- [ ] RLS, authorization, token security, private file access, and audit tests pass.
- [ ] Automated tests, end-to-end tests, and load tests pass.
- [ ] Staging rehearsal and client sign-off are complete.
- [ ] Production monitoring, backups, fallback procedures, training, and escalation plan are ready.

**Do not claim “100% bug-free” or “fault-proof.”** No non-trivial software can honestly guarantee that. The engineering objective is to reduce risk through transaction safety, validation, automated tests, real-hardware rehearsal, observability, backups, and controlled fallback procedures. Be explicit about any untested or unavailable integration.

---

## 19. Recommended implementation sequence for Claude Code

Work in small, reviewable phases. Keep the application runnable after each phase.

### Phase 0 — Project discovery or greenfield bootstrap

- Read both `CLAUDE.md` and `UI_UX_DESIGN.md` completely.
- Inspect the project folder. If code exists, identify the framework, reusable modules, deployment configuration, and risks; preserve sound existing work.
- If the folder is empty or only contains these Markdown requirements, declare it a greenfield project and scaffold the preferred TypeScript/Next.js/Supabase/Render foundation described in Section 2. Do not ask the user to supply a codebase.
- Record architecture choices, data model, route map, environment variables, security approach, and genuinely blocking external approvals in project documentation.
- Create a phase plan, then continue into Phase 1 and implement the actual application. Do not stop after a plan-only response or an empty scaffold.
- Do not overwrite or delete existing user work.

### Phase 1 — Foundation and event configuration

- Authentication, event scoping, RBAC, migrations, audit logging, event settings.
- Packages, test catalogue, package-test mapping, add-on pricing, counters, stations, capabilities, staff shifts.
- Configuration validation before an event can go live.

### Phase 2 — Registration and tag printing

- Participant lookup/duplicate handling, registration transaction, registration code, package task generation.
- QR/barcode token lifecycle, participant portal entry, label preview and print/reprint audit.

### Phase 3 — Add-ons and payment records

- Add-on catalogue/order workflow, price snapshots, consent/confirmation, payment states, receipts, and verified payment handling.
- Integrate an actual provider only after its API/credentials/process are confirmed.

### Phase 4 — Queue engine and station operations

- Task eligibility and dependencies, compatible-station scheduling, atomic reservation, station dashboards, scanning, task completion, reallocation, exceptions, and participant next-step view.
- Test concurrency and queue fairness before proceeding.

### Phase 5 — Walk-in centres

- Centre configuration, participant check-in, visit/task completion, external reference mapping, and pending walk-in dashboard.

### Phase 6 — Reports

- Private report upload, validation, publication, replacement/withdrawal, participant identity verification, and optional LIS integration adapter.

### Phase 7 — Dashboards, finance, and exports

- Live operational dashboard, sponsor reconciliation, add-on revenue/payment reconciliation, report status, and role-controlled exports.

### Phase 8 — Hardening and launch

- Security/RLS tests, load tests, observability, backups/restore, actual hardware rehearsal, staff training, manual fallback, staging sign-off, and production launch checklist.

### Claude Code working rules

- Read this file and `UI_UX_DESIGN.md` completely before implementing. Also inspect existing project files; if none exist, bootstrap the greenfield project as specified in Section 2.
- Do not assume a missing business rule. Make it a documented configurable setting or mark it as a blocker.
- Do not hard-code package names, package tests, prices, station counts, staff names, or payment-provider details.
- Do not mark a task/payment/report complete based only on a frontend click without server-side validation and durable database confirmation.
- Do not expose privileged credentials, participant data, or report files to unauthorized clients.
- Do not remove tests or weaken security checks to make a build pass.
- Add or update migrations and tests with every database/business-logic change.
- Run formatting, linting, type checking, unit/integration tests, and production build after each meaningful phase. Report actual command results; never claim tests passed if they were not run.
- Keep a `README` with local setup, environment variables, migrations, test commands, deployment steps, operational runbook, and recovery steps.
- Maintain a `DECISIONS.md` or equivalent decision log for approved business/architecture decisions.
- Implement all screen designs as real, connected application workflows; do not substitute static mockups or placeholder dashboards for working features.
- At each phase, report: what changed, files/modules touched, migrations added, tests run and outcomes, remaining risks, and next phase.

---

## 20. Business decisions that must be confirmed before production

These questions are intentionally explicit. Use safe/configurable defaults during development, but do not launch the live event until the relevant owner confirms them.

### A. Client and event identity

1. What is the exact legal and display name of the Lab Partner providing this service (Taiyo/Tiyo Labs, Thyrocare, or another entity)? Who is the operational owner for approving package/test configuration?
2. What are the event date, venue, operating hours, and final expected attendance? Is this a single-day event or are there multiple event days?

### B. Packages and clinical workflow configuration

3. The client has confirmed the two package names/categories and requested that the shorthand `B2`, `BT2`, and `D` be kept as supplied rather than interpreted by the software. The Event Admin must be able to edit the test code/display name when the Lab Partner supplies approved catalogue details. Before production, have the Lab Partner approve the exact codes/orderables, including female `T3`, `T4`, `TSH` and male `TFT`; do not silently normalize them.
4. The client has confirmed the Female USG Thyroid/Breast item is a configurable choice between Thyroid and Breast (default one-of-two), and the Male package has USG Thyroid; both are walk-in-centre services. Keep the choice rule configurable in admin. Confirm the centre's exact display/legal name, address, contact details, operating days/hours, appointment rules, and attendance/completion process.
   4a. The client has confirmed the sponsor package rates are ₹2,999 (Female) and ₹1,999 (Male), paid by Bank of India to the Lab Partner. These values must remain backend-only and never appear in the software UI or ordinary exports. Confirm the contractual unit for settlement (e.g. per unique package attendee vs. per-test attendance) before implementing any backend payable calculation. The employee package charge remains ₹0.
5. Which tests must happen before others? Which require fasting, and what exact operational rule should the software apply if a participant is not fasting? Which package test/order lines are fulfilled during one physical visit (for example, a single blood collection encounter), and which need separate station visits? The Lab Partner must approve these mappings and rules; do not infer them from test names.
6. The event has exactly two package classifications: Female and Male. Confirm who can approve a correction/exception to the classification-to-package mapping; the software must not infer classification from the participant's name.
7. Should participants complete strictly one station at a time, as specified here, or are any tests allowed to be queued/performed in parallel?

### C. Add-ons and payments

8. Provide the add-on test catalogue, exact prices, tax/fee rules, availability/location, and whether add-ons can be ordered at any time or only at a dedicated desk.
9. How will participants pay: UPI QR, payment gateway, card, cash, or a combination? For each method, how will the software receive trusted confirmation? Is there an API/webhook or will an authorized cashier verify transactions manually?
10. Can an add-on be cancelled/refunded after payment or after the test starts? Who can approve it?

### D. Hardware and registration fields

11. What printer model, label size, scanner type, and device/browser will be used at registration and stations? Is Code 128, QR, or both required?
12. Which participant details are mandatory (name, age or DOB, employee ID, mobile number, department, etc.)? Is a mobile number available for every participant, and can it be used for OTP verification?
13. What registration-code prefix/format is preferred? Is employee ID supplied by Bank of India and allowed to be used for duplicate checks?

### E. Staff, reports, and integration

14. How many registration counters, add-on desks, blood collection stations, ECG stations, X-ray stations, and other stations will operate? Who will provide the staff/shift roster and capacity estimates?
15. How will Thyrocare/the Lab Partner provide reports: manual PDF upload, bulk ZIP/CSV import, API, webhook, or LIS integration? What identifier will reliably match a report to a participant (registration code, accession number, order ID, etc.)?
16. Should participant report access use mobile OTP, a printed QR plus another verification factor, or an existing patient portal/login? Who owns the SMS/OTP provider and its cost?
17. Who signs off the attendance counts and backend sponsor settlement rule? The software must preserve both unique package-attendee counts and per-test attendance counts; do not expose sponsor money values in the ordinary UI or exports.

### Highest-priority confirmations

Before building the final live configuration, obtain at least: **(1)** Lab Partner approval of the editable prebuilt package/test catalogue, final order codes, and test-line-to-physical-service grouping, **(2)** exact walk-in centre details and appointment/attendance rules, **(3)** approved test sequencing/fasting rules, **(4)** add-on prices and payment-verification method, **(5)** actual station/counter/staff roster, **(6)** printer/scanner/label specifications, **(7)** report upload/matching process, and **(8)** signed-off sponsor settlement unit/formula. The client has confirmed the Male/Female package mapping, brochure sponsor rates, and Female USG choice concept; remaining implementation details must stay configurable until approved.

---

## 21. Final product principle

The event team should be able to answer, at any moment and from one authorized system:

- Who has registered?
- Which package does the participant have?
- Which tests are sponsor-funded and which add-ons are employee-paid?
- Has each add-on payment actually been verified?
- Which test has the participant completed, and which remains?
- Where should the participant go next, and why was that station selected?
- Which stations are busy, paused, unstaffed, or under capacity?
- Which participants still need a walk-in-centre visit?
- Which reports have not arrived, are pending validation, or are published?
- How many unique participants appeared for each sponsored package and each included test, and what amount has actually been received from employee-paid add-ons? (Do not display sponsor money values in the UI.)
- Who changed any important record and why?

If the system cannot answer these questions accurately, with a traceable source of truth, it is not ready for the live event.
