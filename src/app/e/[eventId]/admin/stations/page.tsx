import { AdminForm, isLive } from '@/components/AdminForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, PageHead, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { deleteStation, saveStation } from '../actions';
import { RpcForm } from '@/components/RpcForm';
import { nowMs } from '@/lib/clock';
import { isoToLocalInput } from '@/lib/format';

const KINDS: [string, string][] = [['registration_counter', 'Registration counters'], ['addon_desk', 'Add-on / payment desks'], ['station', 'Diagnostic stations'], ['walkin_centre', 'Walk-in centres']];
type St = { id: string; code: string; name: string; kind: string; status: string; location: string; instructions: string; address: string; operating_hours: string;
  valid_from: string | null; valid_to: string | null; capacity: number; avg_service_minutes: number | null; max_queue: number | null; accepts_assignments: boolean };

export default async function Stations({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await requirePerm(eventId, 'station.configure', 'station.mapping.edit');
  const back = `/e/${eventId}/admin/stations`;
  const live = isLive(ctx.event.status);
  const canShift = ctx.can('shift.assign');
  const [{ data: stations }, { data: services }, { data: caps }, { data: people }, { data: shifts }] = await Promise.all([
    ctx.supabase.from('stations').select('*').eq('event_id', eventId).order('code'),
    ctx.supabase.from('workflow_services').select('id, name, location').eq('event_id', eventId).eq('active', true).order('name'),
    ctx.supabase.from('station_capabilities').select('station_id, service_id').eq('event_id', eventId),
    canShift ? ctx.supabase.rpc('staff_directory', { p_event: eventId }) : Promise.resolve({ data: [] }),
    ctx.supabase.from('staff_assignments').select('station_id, user_id, shift_start, shift_end').eq('event_id', eventId).eq('status', 'active'),
  ]);
  const now = nowMs(); const tz = ctx.event.timezone;
  const ppl = (people ?? []) as { user_id: string; full_name: string }[];
  const onShift = (stationId: string) => [...new Set((shifts ?? []).filter((a) => a.station_id === stationId
    && new Date(a.shift_start).getTime() <= now && new Date(a.shift_end).getTime() >= now).map((a) => a.user_id))]
    .map((u) => ppl.find((p) => p.user_id === u)?.full_name ?? 'staff');
  const startDefault = isoToLocalInput(new Date(now).toISOString(), tz);
  const endDefault = isoToLocalInput(new Date(now + 8 * 3600_000).toISOString(), tz);

  const form = (s?: St, kind?: string) => {
    const k = s?.kind ?? kind!;
    const svcLoc = k === 'walkin_centre' ? 'walk_in' : 'event_day';
    return (
      <AdminForm action={saveStation} eventId={eventId} back={back} live={live} hidden={{ id: s?.id, kind: s ? undefined : k }}>
        <div className="form-row">
          {!s ? <div className="field"><label>Code</label><input name="code" required pattern="[A-Za-z0-9_\-]{1,20}" /></div> : null}
          <div className="field"><label>Name</label><input name="name" defaultValue={s?.name} required /></div>
          <div className="field"><label>Location / room</label><input name="location" defaultValue={s?.location} /></div>
          {k === 'station' ? <>
            <div className="field"><label>Parallel capacity</label><input type="number" name="capacity" min={1} max={50} defaultValue={s?.capacity ?? 1} /></div>
            <div className="field"><label>Avg. minutes</label><input type="number" name="avg_service_minutes" min={1} defaultValue={s?.avg_service_minutes ?? ''} /></div>
            <div className="field"><label>Max waiting</label><input type="number" name="max_queue" min={1} defaultValue={s?.max_queue ?? ''} /></div>
          </> : <input type="hidden" name="capacity" value="1" />}
        </div>
        {k === 'walkin_centre' ? (
          <div className="form-row">
            <div className="field"><label>Address (confirm with Lab Partner)</label><input name="address" defaultValue={s?.address} /></div>
            <div className="field"><label>Operating hours</label><input name="operating_hours" defaultValue={s?.operating_hours} /></div>
            <div className="field"><label>Valid from</label><input type="date" name="valid_from" defaultValue={s?.valid_from ?? ''} /></div>
            <div className="field"><label>Valid to</label><input type="date" name="valid_to" defaultValue={s?.valid_to ?? ''} /></div>
          </div>) : null}
        <div className="field"><label>Instructions shown to participants</label><input name="instructions" defaultValue={s?.instructions} /></div>
        {['station', 'walkin_centre'].includes(k) ? (
          <div style={{ marginBottom: 10 }}>{ctx.can('station.mapping.edit') ? <input type="hidden" name="caps_present" value="1" /> : null}
            <div className="label">What does this {k === 'station' ? 'station' : 'centre'} do? (required)</div>
            {(services ?? []).some((x) => x.location === svcLoc) ? (
              <div className="row">{(services ?? []).filter((x) => x.location === svcLoc).map((x) => (
                <label key={x.id} className="check small"><input type="checkbox" name="caps" value={x.id} defaultChecked={(caps ?? []).some((c) => c.station_id === s?.id && c.service_id === x.id)} disabled={!ctx.can('station.mapping.edit')} />{x.name}</label>))}</div>
            ) : <p className="small muted" style={{ margin: '4px 0' }}>No {k === 'station' ? 'event-day' : 'walk-in'} visits exist yet — type one below.</p>}
            {ctx.can('station.mapping.edit') ? (
              <div className="field" style={{ marginTop: 8 }}><label htmlFor={`ns-${s?.id ?? k}`}>{(services ?? []).some((x) => x.location === svcLoc) ? 'Or add a new visit type' : 'Visit type'}</label>
                <input id={`ns-${s?.id ?? k}`} name="new_service" list={`visits-${k}`} maxLength={80} placeholder={k === 'station' ? 'e.g. Ultrasound (USG), 2D Echo — comma-separate to do several here' : 'e.g. USG screening'} />
                <span className="help">One station type per kind of visit: a <strong>blood sample collection</strong> station handles every blood test (CBC, HbA1c, lipid…); an <strong>X-Ray</strong> station handles X-Ray only. One room can do several visits (tick them, or type &ldquo;Ultrasound (USG), 2D Echo&rdquo;). Left empty, the station name becomes its visit. Add more stations of the same type to run them in parallel.</span></div>) : null}
          </div>) : null}
        <div className="row"><label className="check"><input type="checkbox" name="accepts_assignments" defaultChecked={s?.accepts_assignments ?? true} />Accepts new assignments</label><SubmitButton className="btn btn-solid btn-sm">{s ? 'Save' : 'Create'}</SubmitButton></div>
      </AdminForm>
    );
  };

  return (
    <>
      <PageHead title="Stations & counters" meta="Each diagnostic station does one kind of visit (blood sample collection, X-Ray, ECG…). Tests are linked to visits in the Test catalogue. A station receives patients only when open and staffed on shift — open/pause/close in Queue control." />
      <datalist id="visits-station"><option value="Blood sample collection" /><option value="X-Ray" /><option value="ECG" /><option value="BMD" /><option value="Body composition" /><option value="Ultrasound (USG)" /><option value="2D Echo" /><option value="Ultrasound (USG), 2D Echo" /><option value="Eye check-up" /><option value="Dental check-up" /><option value="Doctor consultation" /></datalist>
      <datalist id="visits-walkin_centre"><option value="USG screening" /><option value="2D Echo" /><option value="Mammography" /></datalist>
      {KINDS.map(([kind, label]) => {
        const list = ((stations ?? []) as St[]).filter((s) => s.kind === kind);
        return (
          <Card key={kind} title={label} sub={`${list.length} configured`}>
            <div className="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Services</th><th>On shift now</th><th></th></tr></thead>
              <tbody>{list.map((s) => (
                <tr key={s.id}><td className="mono">{s.code}</td><td className="strong">{s.name}<div className="small muted">{s.location}</div></td><td><StatusBadge status={s.status} /></td>
                  <td className="wrap small">{(caps ?? []).filter((c) => c.station_id === s.id).map((c) => (services ?? []).find((x) => x.id === c.service_id)?.name).join(', ')
                    || (['station', 'walkin_centre'].includes(s.kind) ? <span className="badge red">none — cannot receive participants</span> : '—')}</td>
                  <td className="small">{onShift(s.id).join(', ') || <span className="badge amber">nobody</span>}
                    {canShift && ppl.length ? (
                      <details style={{ marginTop: 6 }}><summary className="btn btn-ghost btn-sm">Add staff</summary>
                        <RpcForm eventId={eventId} rpc="assign_staff" back={back} ok={`Shift assigned at ${s.name} — the right access was given automatically`} hidden={{ p_station: s.id }} style={{ marginTop: 8, minWidth: 240 }}>
                          <div className="field"><label htmlFor={`as-${s.id}`}>Person</label><select id={`as-${s.id}`} name="p_user" required>{ppl.map((p) => <option key={p.user_id} value={p.user_id}>{p.full_name}</option>)}</select></div>
                          <div className="field"><label htmlFor={`ss-${s.id}`}>From</label><input id={`ss-${s.id}`} type="datetime-local" name="p_start_local" required defaultValue={startDefault} /></div>
                          <div className="field"><label htmlFor={`se-${s.id}`}>Until</label><input id={`se-${s.id}`} type="datetime-local" name="p_end_local" required defaultValue={endDefault} /></div>
                          <SubmitButton className="btn btn-solid btn-sm">Assign</SubmitButton>
                        </RpcForm>
                      </details>) : null}</td>
                  <td><details><summary className="btn btn-ghost btn-sm">Edit</summary><div style={{ width: 'min(720px, 86vw)', whiteSpace: 'normal', padding: '10px 0' }}>{form(s)}
                    {ctx.can('station.configure') ? (
                      <AdminForm action={deleteStation} eventId={eventId} back={back} live={live} hidden={{ id: s.id }} style={{ marginTop: 10 }}>
                        <SubmitButton className="btn btn-red btn-sm" confirm={`Delete ${s.name}? Only possible if it never handled a participant; otherwise close it in Queue control.`}>Delete station</SubmitButton>
                      </AdminForm>) : null}</div></details></td></tr>))}</tbody></table></div>
            {ctx.can('station.configure') ? <details style={{ marginTop: 12 }}><summary className="btn btn-ghost btn-sm">Add {label.toLowerCase().replace(/s$/, '')}</summary><div style={{ marginTop: 10 }}>{form(undefined, kind)}</div></details> : null}
          </Card>
        );
      })}
    </>
  );
}
