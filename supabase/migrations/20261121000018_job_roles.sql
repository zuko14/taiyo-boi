-- Job-based roles that staff recognise. Phlebotomists and X-Ray technicians get exactly the
-- station technician's permissions (perform tasks at the station their shift is on); which room
-- they work in comes from their shift. Role permissions are read live by has_perm(), so editing a
-- role's permissions applies immediately to everyone holding it.

insert into public.roles (code, name, description) values
  ('phlebotomist', 'Phlebotomist (sample collection)', 'Collects blood / samples at a sample collection station'),
  ('radiology_technician', 'X-Ray / radiology technician', 'Performs X-Ray and imaging at an X-Ray station')
on conflict (code) do nothing;

-- plain-language names and what each role is for
update public.roles r set name = v.name, description = v.description
  from (values
    ('event_admin', 'Event Admin', 'Sets up and runs the whole event: tests, packages, prices, stations, staff, payments'),
    ('registration_supervisor', 'Registration Supervisor', 'Oversees the registration desks; can correct registrations and reprint tags'),
    ('registration_staff', 'Registration Desk', 'Registers patients, picks their tests or package, prints the tag'),
    ('addon_staff', 'Add-on Desk', 'Adds extra paid tests for a registered patient'),
    ('cashier', 'Cashier / Payment Desk', 'Confirms UPI and cash payments and issues receipts'),
    ('station_supervisor', 'Station Supervisor', 'Opens, pauses and closes stations; resolves queue problems'),
    ('station_staff', 'Station Technician (ECG, BMD, other)', 'Serves patients at the station their shift is on'),
    ('walkin_staff', 'Walk-in Centre Staff', 'Checks in and serves patients at the walk-in centre'),
    ('report_manager', 'Report Manager / Lab Staff', 'Uploads, checks and publishes reports'),
    ('finance_viewer', 'Finance / Audit Viewer', 'Sees revenue, payments and the audit log (read only)'),
    ('sponsor_viewer', 'Sponsor Viewer', 'Sees sponsor attendance counts only (read only)')
  ) as v(code, name, description)
 where r.code = v.code;

insert into public.default_role_permissions (role_code, permission_code)
select j.role, d.permission_code from public.default_role_permissions d
 cross join (values ('phlebotomist'), ('radiology_technician')) as j(role)
 where d.role_code = 'station_staff'
on conflict do nothing;

-- existing events: copy each event's own station technician permissions
insert into public.role_permissions (event_id, role_code, permission_code)
select rp.event_id, j.role, rp.permission_code from public.role_permissions rp
 cross join (values ('phlebotomist'), ('radiology_technician')) as j(role)
 where rp.role_code = 'station_staff'
on conflict do nothing;
