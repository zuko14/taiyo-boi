-- Operational records: participants, registrations, orders, tasks, queue,
-- attendance ledger, walk-in visits, payments, reports, portal access.

create table public.participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  full_name text not null check (length(btrim(full_name)) between 1 and 120),
  name_search text generated always as (lower(regexp_replace(btrim(full_name), '\s+', ' ', 'g'))) stored,
  age int check (age between 0 and 120),
  age_as_of date default current_date,
  employee_id text check (employee_id is null or length(employee_id) <= 40),
  mobile text check (mobile is null or mobile ~ '^[0-9]{10}$'),
  email text,
  department text,
  consent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, id)
);
create index on public.participants (event_id, employee_id);
create index on public.participants (event_id, mobile);
create index on public.participants (event_id, name_search);

create table public.package_code_counters (
  event_id uuid not null references public.events(id),
  classification text not null check (classification in ('female','male')),
  next_seq int not null,
  primary key (event_id, classification)
);

create table public.registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  participant_id uuid not null,
  registration_code text not null,
  classification text not null check (classification in ('female','male')),
  package_id uuid not null,
  package_version_id uuid not null references public.package_configuration_versions(id),
  counter_station_id uuid references public.stations(id),
  status text not null default 'active' check (status in ('active','duplicate_void','cancelled')),
  duplicate_of uuid references public.registrations(id),
  classification_override_reason text,
  idempotency_key text not null,
  tag_version int not null default 0,
  tag_printed_confirmed_at timestamptz,
  arrived_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (event_id, registration_code),
  unique (event_id, idempotency_key),
  unique (event_id, id),
  foreign key (event_id, participant_id) references public.participants(event_id, id),
  foreign key (event_id, package_id) references public.packages(event_id, id)
);
create index on public.registrations (event_id, created_at desc);

create table public.registration_tokens (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.registrations(id),
  token_hash text not null unique,          -- sha256 hex; plaintext never stored or logged
  tag_version int not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text
);
create unique index registration_tokens_one_active on public.registration_tokens (registration_id) where revoked_at is null;

create table public.tag_prints (
  id bigint generated always as identity primary key,
  registration_id uuid not null references public.registrations(id),
  tag_version int not null,
  kind text not null check (kind in ('original','reprint')),
  reason text,
  printed_by uuid,
  created_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  registration_id uuid not null references public.registrations(id),
  kind text not null check (kind in ('package','addon')),
  status text not null default 'active' check (status in ('active','cancelled')),
  total_paise bigint not null default 0 check (total_paise >= 0),
  idempotency_key text,
  consent_at timestamptz,
  desk_station_id uuid references public.stations(id),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (registration_id, idempotency_key)
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  order_id uuid not null references public.orders(id),
  registration_id uuid not null references public.registrations(id),
  test_id uuid not null references public.test_catalog(id),
  test_code text not null,                -- snapshot
  test_name text not null,                -- snapshot
  location text not null check (location in ('event_day','walk_in')),
  source text not null check (source in ('package','addon')),
  responsibility text not null check (responsibility in ('sponsor','employee')),
  unit_price_paise bigint not null default 0 check (unit_price_paise >= 0),
  tax_paise bigint not null default 0 check (tax_paise >= 0),
  quantity int not null default 1 check (quantity > 0),
  choice_group_id uuid,
  completion_rule text not null default 'fulfilled_on_complete',
  status text not null default 'active' check (status in ('active','cancelled')),
  external_accession text,
  created_at timestamptz not null default now(),
  -- sponsor-funded lines can never carry an employee charge
  check (responsibility = 'employee' or (unit_price_paise = 0 and tax_paise = 0)),
  check ((source = 'package') = (responsibility = 'sponsor'))
);
create index on public.order_items (registration_id);
create index on public.order_items (event_id, test_id);

create table public.payment_intents (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  order_id uuid not null unique references public.orders(id),
  registration_id uuid not null references public.registrations(id),
  amount_paise bigint not null check (amount_paise > 0),
  refunded_paise bigint not null default 0 check (refunded_paise >= 0),
  currency text not null default 'INR',
  status text not null default 'pending' check (status in
    ('pending','paid','failed','cancelled','partially_refunded','refunded','requires_review','waived')),
  status_reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (refunded_paise <= amount_paise)
);
create index on public.payment_intents (event_id, status);

create table public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  intent_id uuid not null references public.payment_intents(id),
  method text not null,
  provider_ref text,
  amount_paise bigint not null check (amount_paise >= 0),
  status text not null check (status in ('verified','rejected','failed')),
  note text,
  verified_by uuid,
  created_at timestamptz not null default now()
);
create unique index payment_transactions_ref_unique
  on public.payment_transactions (event_id, method, provider_ref)
  where status = 'verified' and provider_ref is not null;
create unique index payment_transactions_one_verified on public.payment_transactions (intent_id) where status = 'verified';

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  intent_id uuid not null references public.payment_intents(id),
  amount_paise bigint not null check (amount_paise > 0),
  reason text not null,
  provider_ref text,
  actor_id uuid,
  created_at timestamptz not null default now()
);

create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  intent_id uuid not null unique references public.payment_intents(id),
  receipt_no text not null,
  snapshot jsonb not null,
  issued_by uuid,
  issued_at timestamptz not null default now(),
  unique (event_id, receipt_no)
);

create table public.walkin_visits (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  registration_id uuid not null references public.registrations(id),
  centre_id uuid not null references public.stations(id),
  visit_date date not null,
  checked_in_by uuid,
  checked_in_at timestamptz not null default now(),
  unique (registration_id, centre_id, visit_date)
);

create table public.participant_tasks (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  registration_id uuid not null references public.registrations(id),
  service_id uuid not null references public.workflow_services(id),
  service_name text not null,                         -- snapshot
  location text not null check (location in ('event_day','walk_in')),
  source text not null check (source in ('package','addon')),
  status text not null check (status in (
    'awaiting_choice','not_ready','waiting_unassigned','queued','called','in_service',
    'completed','no_show','skipped','cancelled','exception','not_attended','checked_in')),
  priority int not null default 100,
  fasting_required boolean not null default false,
  depends_on_service_ids uuid[] not null default '{}',
  choice_group_id uuid,
  payment_intent_id uuid references public.payment_intents(id),
  payment_exception boolean not null default false,
  station_id uuid references public.stations(id),
  walkin_visit_id uuid references public.walkin_visits(id),
  external_accession text,
  status_reason text,
  waiting_since timestamptz,
  completed_at timestamptz,
  completed_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.participant_tasks (registration_id);
create index on public.participant_tasks (event_id, status);

create table public.task_items (
  task_id uuid not null references public.participant_tasks(id),
  order_item_id uuid not null references public.order_items(id),
  primary key (task_id, order_item_id)
);
create index on public.task_items (order_item_id);

create table public.queue_assignments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  task_id uuid not null references public.participant_tasks(id),
  registration_id uuid not null references public.registrations(id),
  station_id uuid not null references public.stations(id),
  seq int not null,
  state text not null default 'queued' check (state in
    ('queued','called','in_service','completed','no_show','cancelled','reassigned','exception')),
  reason text not null,
  score jsonb not null default '{}'::jsonb,
  assigned_by uuid,                                   -- null = scheduler
  assigned_at timestamptz not null default now(),
  called_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz
);
-- one active assignment per participant (parallel routing is not enabled) and per task
create unique index queue_one_active_per_registration on public.queue_assignments (registration_id)
  where state in ('queued','called','in_service');
create unique index queue_one_active_per_task on public.queue_assignments (task_id)
  where state in ('queued','called','in_service');
create index on public.queue_assignments (station_id, state);

create table public.task_status_history (
  id bigint generated always as identity primary key,
  event_id uuid not null,
  task_id uuid not null references public.participant_tasks(id),
  from_status text,
  to_status text not null,
  actor_id uuid,
  station_id uuid,
  reason text,
  source text not null default 'user',
  created_at timestamptz not null default now()
);
create index on public.task_status_history (task_id);
create trigger tsh_append_only before update or delete on public.task_status_history
  for each row execute function public.forbid_mutation();

-- Immutable, deduplicated per-order-line attendance ledger for sponsor reconciliation.
create table public.task_attendance_events (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events(id),
  registration_id uuid not null references public.registrations(id),
  order_item_id uuid not null references public.order_items(id),
  test_id uuid not null,
  package_id uuid,
  source text not null,
  kind text not null check (kind in ('appeared','completed','no_show','exception')),
  task_id uuid,
  station_id uuid,
  actor_id uuid,
  created_at timestamptz not null default now(),
  unique (order_item_id, kind)
);
create index on public.task_attendance_events (event_id, test_id, kind);
create trigger tae_append_only before update or delete on public.task_attendance_events
  for each row execute function public.forbid_mutation();

create table public.scan_events (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events(id),
  registration_id uuid references public.registrations(id),
  station_id uuid,
  actor_id uuid,
  result text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- reports
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  registration_id uuid not null references public.registrations(id),
  order_item_id uuid not null references public.order_items(id),
  title text not null,
  storage_key text not null unique,
  file_name text not null,
  mime_type text not null check (mime_type in ('application/pdf','image/png','image/jpeg')),
  size_bytes int not null check (size_bytes > 0 and size_bytes <= 15728640),
  checksum_sha256 text not null,
  version int not null,
  accession_ref text,
  status text not null check (status in ('uploading','uploaded_pending_validation','validated','published',
    'replaced','withdrawn','upload_failed','requires_review')),
  status_reason text,
  replaces_report_id uuid references public.reports(id),
  uploaded_by uuid, uploaded_at timestamptz not null default now(),
  validated_by uuid, validated_at timestamptz,
  published_by uuid, published_at timestamptz,
  withdrawn_by uuid, withdrawn_at timestamptz,
  unique (order_item_id, version)
);
create index on public.reports (event_id, status);
create unique index reports_one_published on public.reports (order_item_id) where status = 'published';

-- LIS/API import adapter boundary: unmatched/ambiguous imports wait here for review.
create table public.report_import_jobs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  source text not null,
  external_id text not null,
  match_key text,
  status text not null default 'received' check (status in ('received','matched','unmatched','failed','imported')),
  report_id uuid references public.reports(id),
  error text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  unique (event_id, source, external_id)
);

-- ---------------------------------------------------------------- participant portal access
create table public.portal_otps (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.registrations(id),
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.portal_otps (registration_id, created_at desc);

create table public.portal_sessions (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.registrations(id),
  session_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
