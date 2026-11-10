import { AdminForm, isLive } from '@/components/AdminForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, PageHead, StatusBadge } from '@/components/ui';
import { requirePerm } from '@/lib/auth';
import { saveStation } from '../actions';

const KINDS: [string, string][] = [['registration_counter', 'Registration counters'], ['addon_desk', 'Add-on / payment desks'], ['station', 'Diagnostic stations'], ['walkin_centre', 'Walk-in centres']];
type St = { id: string; code: string; name: string; kind: string; status: string; location: string; instructions: string; address: string; operating_hours: string;
  valid_from: string | null; valid_to: string | null; capacity: number; avg_service_minutes: number | null; max_queue: number | null; accepts_assignments: boolean };

export default async function Stations({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const ctx = await requirePerm(eventId, 'station.configure', 'station.mapping.edit');
  const back = `/e/${eventId}/admin/stations`;
  const live = isLive(ctx.event.status);
  const [{ data: stations }, { data: services }, { data: caps }] = await Promise.all([
    ctx.supabase.from('stations').select('*').eq('event_id', eventId).order('code'),
    ctx.supabase.from('workflow_services').select('id, name, location').eq('event_id', eventId).eq('active', true).order('name'),
    ctx.supabase.from('station_capabilities').select('station_id, service_id').eq('event_id', eventId),
  ]);

  const form = (s?: St, kind?: string) => {
    const k = s?.kind ?? kind!;
    const svcLoc = k === 'walkin_centre' ? 'walk_in' : 'event_day';
    return (
      <AdminForm action={saveStation} eventId={eventId} back={back} live={live} hidden={{ id: s?.id, kind: s ? undefined : k }}>
        <div className="form-row">
          {!s ? <div className="field"><label>Code</label><input name="code" required pattern="[A-Za-z0-9_-]{1,20}" /></div> : null}
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
          <div style={{ marginBottom: 10 }}><input type="hidden" name="caps_present" value="1" />
            <div className="label">Services this {k === 'station' ? 'station' : 'centre'} can perform</div>
            <div className="row">{(services ?? []).filter((x) => x.location === svcLoc).map((x) => (
              <label key={x.id} className="check small"><input type="checkbox" name="caps" value={x.id} defaultChecked={(caps ?? []).some((c) => c.station_id === s?.id && c.service_id === x.id)} disabled={!ctx.can('station.mapping.edit')} />{x.name}</label>))}</div>
          </div>) : null}
        <div className="row"><label className="check"><input type="checkbox" name="accepts_assignments" defaultChecked={s?.accepts_assignments ?? true} />Accepts new assignments</label><SubmitButton className="btn btn-solid btn-sm">{s ? 'Save' : 'Create'}</SubmitButton></div>
      </AdminForm>
    );
  };

  return (
    <>
      <PageHead title="Stations & counters" meta="Open/pause/close is done in Queue control. A station only receives work when open, staffed and on shift." />
      {KINDS.map(([kind, label]) => {
        const list = ((stations ?? []) as St[]).filter((s) => s.kind === kind);
        return (
          <Card key={kind} title={label} sub={`${list.length} configured`}>
            <div className="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Services</th><th></th></tr></thead>
              <tbody>{list.map((s) => (
                <tr key={s.id}><td className="mono">{s.code}</td><td className="strong">{s.name}<div className="small muted">{s.location}</div></td><td><StatusBadge status={s.status} /></td>
                  <td className="wrap small">{(caps ?? []).filter((c) => c.station_id === s.id).map((c) => (services ?? []).find((x) => x.id === c.service_id)?.name).join(', ') || '—'}</td>
                  <td><details><summary className="btn btn-ghost btn-sm">Edit</summary><div style={{ width: 720, whiteSpace: 'normal', padding: '10px 0' }}>{form(s)}</div></details></td></tr>))}</tbody></table></div>
            {ctx.can('station.configure') ? <details style={{ marginTop: 12 }}><summary className="btn btn-ghost btn-sm">Add {label.toLowerCase().replace(/s$/, '')}</summary><div style={{ marginTop: 10 }}>{form(undefined, kind)}</div></details> : null}
          </Card>
        );
      })}
    </>
  );
}
