// Maps database exception prefixes (raised by the SQL functions) to plain-language messages.
const MESSAGES: Record<string, string> = {
  permission_denied: 'You do not have permission for this action.',
  not_on_duty: 'You have no active shift at this counter/station.',
  event_not_live: 'The event is not live, so operational changes are blocked.',
  reason_required: 'A reason is required for this action.',
  consent_required: 'Participant consent / confirmation is required.',
  illegal_transition: 'That action is not allowed in the current state.',
  wrong_station: 'This task is assigned to a different station.',
  incompatible_station: 'That station cannot perform this service.',
  station_unavailable: 'That station is not open.',
  payment_pending: 'The payment has not been verified yet.',
  maker_checker: 'A different person must perform this step.',
  method_not_configured: 'That payment method is not approved for this event.',
  included_in_package: 'Already included in the sponsored package.',
  price_missing: 'No active price configured.',
  already_ordered: 'Already ordered for this participant.',
  not_ready: 'The event configuration has errors. Fix them first.',
  registration_inactive: 'This registration is not active.',
  invalid_choice: 'Invalid selection.',
  choice_locked: 'The selection can no longer be changed.',
  rate_limited: 'Too many attempts. Please wait and try again.',
  no_mobile: 'No mobile number is on file. Please contact the help desk.',
  verification_required: 'Please verify with the code sent to your mobile.',
  duplicate_has_activity: 'Tasks were already performed on this registration.',
  participant_busy: 'The participant already has another active assignment.',
  config_invalid: 'The package configuration is incomplete.',
  registration_closed: 'Registration is not open at this time.',
  confirm_mismatch: 'The confirmation did not match.',
  event_live: 'The event is live.',
  in_use: 'This item is in use.',
  package_mode: 'Not allowed for this event\'s package setup.',
  invalid_code: 'Invalid code.',
  invalid_import: 'The catalogue file could not be imported.',
  no_tests_selected: 'Select at least one test.',
  not_available_as_addon: 'This test is not offered for sale.',
  invalid_classification: 'Choose a package.',
  '23503': 'This item is still referenced by other records. Archive or deactivate it instead.',
  '23505': 'This record already exists (duplicate).',
  '57014': 'The system is busy. Please retry — your previous attempt did not complete.',
  '40P01': 'The system is busy. Please retry.',
};

export function friendlyError(e: { message?: string; code?: string } | null | undefined): string {
  if (!e) return 'Unknown error';
  const msg = e.message ?? '';
  const key = msg.split(':')[0].trim();
  const base = MESSAGES[key] ?? (e.code ? MESSAGES[e.code] : undefined);
  if (!base) return msg || 'Unexpected error';
  const detail = msg.includes(':') ? msg.slice(msg.indexOf(':') + 1).trim() : '';
  return detail && !base.toLowerCase().includes(detail.toLowerCase()) ? `${base} (${detail})` : base;
}
