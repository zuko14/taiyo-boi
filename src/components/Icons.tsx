// Inline SVG sprite (ui_ux.txt §8): 24x24 grid, 1.75 stroke, currentColor, no emoji.
const P: Record<string, string> = {
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0',
  building: 'M4 21V3h12v18M16 9h4v12M8 7h4M8 11h4M8 15h4M2 21h20',
  card: 'M2 5h20v14H2zM2 10h20',
  close: 'M18 6 6 18M6 6l12 12',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  pencil: 'M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.35-4.35',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-2.82-1.17l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3.26 14H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.17-2.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 2.82 1.17l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 20.91 10H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  shuffle: 'M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  'trending-up': 'M23 6l-9.5 9.5-5-5L1 18M17 6h6v6',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  wallet: 'M20 7H5a2 2 0 0 1 0-4h14v4M3 5v14a2 2 0 0 0 2 2h15V7M16 14h.01',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9z',
  scan: 'M3 7V3h4M17 3h4v4M21 17v4h-4M7 21H3v-4M7 12h10',
  printer: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  check: 'M20 6 9 17l-5-5',
  clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2',
  pin: 'M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0zM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  arrow: 'M5 12h14M12 5l7 7-7 7',
};

export type IconName = keyof typeof P;

export function Icon({ name, lg, label }: { name: IconName; lg?: boolean; label?: string }) {
  return (
    <svg className={lg ? 'i i-lg' : 'i'} viewBox="0 0 24 24" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      <path d={P[name]} />
    </svg>
  );
}

/** Kriya mark (ui_ux.txt §1.1). Always shown with the wordmark. */
export function KriyaMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="km-hex" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#43E2A6" /><stop offset="1" stopColor="#3D8BFD" /></linearGradient>
        <linearGradient id="km-stem" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#43E2A6" /><stop offset="1" stopColor="#0C9668" /></linearGradient>
        <linearGradient id="km-arm" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stopColor="#3D8BFD" /><stop offset=".5" stopColor="#2FA8D8" /><stop offset="1" stopColor="#43E2A6" /></linearGradient>
      </defs>
      <path d="M16 2.2 27.9 9v13.6L16 29.4 4.1 22.6V9z" fill="none" stroke="url(#km-hex)" strokeOpacity=".4" strokeWidth="1.2" />
      <path d="M11.2 7.6v16.8" stroke="url(#km-stem)" strokeWidth="3.6" strokeLinecap="round" />
      <path d="M22.9 7.6 14.2 16l8.7 8.4" fill="none" stroke="url(#km-arm)" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14.2 13.3 16.9 16l-2.7 2.7L11.5 16z" fill="#9FF0D2" />
    </svg>
  );
}
