-- Event configuration: test catalogue, packages, choice groups, workflow services,
-- stations, staff shifts, add-on prices, backend-only sponsor rates.

create table public.test_catalog (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_-]{1,40}$'),
  display_name text not null,
  category text not null default '',
  source_wording text not null default '',      -- original brochure string, kept for audit
  lab_order_code text,
  instructions text not null default '',
  location text not null check (location in ('event_day','walk_in')),
  active boolean not null default true,
  archived boolean not null default false,
  addon_available boolean not null default false,
  created_at timestamptz not null default now(),
  unique (event_id, code),
  unique (event_id, id)
);

create table public.packages (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  classification text not null check (classification in ('female','male')),
  code text not null,
  name text not null,
  description text not null default '',
  code_letter text not null check (code_letter ~ '^[A-Z]{1,3}$'),
  eligibility_note text not null default '',
  active boolean not null default true,
  active_from timestamptz,
  active_to timestamptz,
  created_at timestamptz not null default now(),
  -- exactly one package per classification: an event can never have a third category
  unique (event_id, classification),
  unique (event_id, code),
  unique (event_id, id)
);

-- Queueable physical encounter (blood collection visit, ECG, X-Ray, walk-in USG...)
create table public.workflow_services (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_-]{1,40}$'),
  name text not null,
  location text not null check (location in ('event_day','walk_in')),
  priority int not null default 100,          -- lower = earlier; must be lab-approved
  est_minutes int check (est_minutes > 0),
  instructions text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (event_id, code),
  unique (event_id, id)
);

-- Which order lines a service encounter fulfils. A test maps to at most one service per event.
-- shortcut: grouping is per event, not per package; add package_id here if the lab needs per-package groups.
create table public.workflow_service_tests (
  event_id uuid not null,
  service_id uuid not null,
  test_id uuid not null,
  completion_rule text not null default 'fulfilled_on_complete'
    check (completion_rule in ('fulfilled_on_complete','manual_confirm')),
  primary key (service_id, test_id),
  unique (event_id, test_id),
  foreign key (event_id, service_id) references public.workflow_services(event_id, id) on delete cascade,
  foreign key (event_id, test_id) references public.test_catalog(event_id, id) on delete cascade
);

create table public.choice_groups (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  package_id uuid not null,
  code text not null,
  name text not null,
  source_wording text not null default '',
  rule text not null default 'one_of' check (rule in ('one_of','one_or_more','bundled')),
  separate_tasks boolean not null default false,
  service_id uuid not null,
  required boolean not null default true,
  created_at timestamptz not null default now(),
  unique (package_id, code),
  foreign key (event_id, package_id) references public.packages(event_id, id) on delete cascade,
  foreign key (event_id, service_id) references public.workflow_services(event_id, id)
);

create table public.package_tests (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  package_id uuid not null,
  test_id uuid not null,
  quantity int not null default 1 check (quantity > 0),
  required boolean not null default true,
  choice_group_id uuid references public.choice_groups(id) on delete set null,
  priority int not null default 100,
  fasting_required boolean not null default false,
  depends_on_test_ids uuid[] not null default '{}',
  est_minutes int check (est_minutes > 0),
  created_at timestamptz not null default now(),
  unique (package_id, test_id),
  foreign key (event_id, package_id) references public.packages(event_id, id) on delete cascade,
  foreign key (event_id, test_id) references public.test_catalog(event_id, id)
);

create table public.package_configuration_versions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  package_id uuid not null references public.packages(id),
  snapshot_hash text not null,
  snapshot jsonb not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (package_id, snapshot_hash)
);
create trigger pcv_append_only before update or delete on public.package_configuration_versions
  for each row execute function public.forbid_mutation();

-- Backend-only sponsor reference rates. RLS on, no policies, no grants: never readable by clients.
create table public.sponsor_backend_rates (
  event_id uuid not null references public.events(id) on delete cascade,
  classification text not null check (classification in ('female','male')),
  amount_paise bigint not null check (amount_paise >= 0),
  currency text not null default 'INR',
  settlement_unit text not null default 'unconfirmed'
    check (settlement_unit in ('unconfirmed','per_unique_package_attendee','per_test_attendance','other')),
  note text not null default '',
  primary key (event_id, classification)
);

create table public.addon_prices (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  test_id uuid not null,
  price_paise bigint not null check (price_paise >= 0),
  tax_paise bigint not null default 0 check (tax_paise >= 0),
  currency text not null default 'INR',
  location_scope text not null default 'both' check (location_scope in ('event_day','walk_in','both')),
  require_payment_before_service boolean not null default true,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  active boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from),
  foreign key (event_id, test_id) references public.test_catalog(event_id, id)
);
create index on public.addon_prices (event_id, test_id) where active;

-- Counters, add-on desks, diagnostic stations and walk-in centres
create table public.stations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_-]{1,20}$'),
  name text not null,
  kind text not null check (kind in ('registration_counter','addon_desk','station','walkin_centre')),
  location text not null default '',
  instructions text not null default '',
  address text not null default '',
  operating_hours text not null default '',
  valid_from date,
  valid_to date,
  capacity int not null default 1 check (capacity between 1 and 50),
  avg_service_minutes int check (avg_service_minutes > 0),
  max_queue int check (max_queue > 0),
  status text not null default 'closed' check (status in ('open','paused','closed')),
  pause_reason text,
  accepts_assignments boolean not null default true,
  next_seq int not null default 1,
  last_assigned_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, code),
  unique (event_id, id)
);

create table public.station_capabilities (
  event_id uuid not null,
  station_id uuid not null,
  service_id uuid not null,
  primary key (station_id, service_id),
  foreign key (event_id, station_id) references public.stations(event_id, id) on delete cascade,
  foreign key (event_id, service_id) references public.workflow_services(event_id, id) on delete cascade
);
create index on public.station_capabilities (service_id);

create table public.station_events (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events(id),
  station_id uuid not null references public.stations(id),
  from_status text,
  to_status text not null,
  reason text,
  actor_id uuid,
  created_at timestamptz not null default now()
);

-- Shift history is retained: ending a shift sets status='ended', never deletes.
create table public.staff_assignments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  user_id uuid not null references public.staff_profiles(user_id),
  station_id uuid not null,
  shift_start timestamptz not null,
  shift_end timestamptz not null,
  status text not null default 'active' check (status in ('active','ended')),
  created_by uuid,
  ended_by uuid,
  created_at timestamptz not null default now(),
  check (shift_end > shift_start),
  foreign key (event_id, station_id) references public.stations(event_id, id)
);
create index on public.staff_assignments (station_id) where status = 'active';
create index on public.staff_assignments (user_id) where status = 'active';

-- audit + live-config guard
create trigger test_catalog_audit after insert or update or delete on public.test_catalog
  for each row execute function public.config_audit();
create trigger packages_audit after insert or update or delete on public.packages
  for each row execute function public.config_audit();
create trigger services_audit after insert or update or delete on public.workflow_services
  for each row execute function public.config_audit();
create trigger service_tests_audit after insert or update or delete on public.workflow_service_tests
  for each row execute function public.config_audit();
create trigger choice_groups_audit after insert or update or delete on public.choice_groups
  for each row execute function public.config_audit();
create trigger package_tests_audit after insert or update or delete on public.package_tests
  for each row execute function public.config_audit();
create trigger addon_prices_audit after insert or update or delete on public.addon_prices
  for each row execute function public.config_audit();
create trigger capabilities_audit after insert or update or delete on public.station_capabilities
  for each row execute function public.config_audit();
-- operational columns (status, queue counters) change through RPCs which write their own history
create trigger stations_audit after insert or delete on public.stations
  for each row execute function public.config_audit();
create trigger stations_audit_upd after update on public.stations
  for each row when (
    (old.name, old.code, old.kind, old.location, old.instructions, old.address, old.operating_hours,
     old.capacity, old.avg_service_minutes, old.max_queue, old.accepts_assignments, old.valid_from, old.valid_to)
    is distinct from
    (new.name, new.code, new.kind, new.location, new.instructions, new.address, new.operating_hours,
     new.capacity, new.avg_service_minutes, new.max_queue, new.accepts_assignments, new.valid_from, new.valid_to))
  execute function public.config_audit();
