export interface TagInfo { code: string; name: string; age: number | null; pkg: string; event: string; showAge: boolean; w: number; h: number }

/** Printed tag. Visible text is human-readable; the QR holds only an opaque portal token. */
export function TagLabel({ info, qr, bar }: { info: TagInfo; qr: string; bar: string }) {
  return (
    <div className="tag" style={{ ['--tag-w' as string]: `${info.w}mm`, ['--tag-h' as string]: `${info.h}mm` }}>
      <div>
        <div className="t-code">{info.code}</div>
        <div className="t-name">{info.name}</div>
        <div className="t-meta">{info.showAge && info.age != null ? `Age ${info.age} · ` : ''}{info.pkg}</div>
        <div className="t-meta">{info.event}</div>
      </div>
      <div className="t-qr" dangerouslySetInnerHTML={{ __html: qr }} />
      <div className="t-bar" dangerouslySetInnerHTML={{ __html: bar }} />
    </div>
  );
}
