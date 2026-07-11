export function AtomicMark({ size = 32, active = false, className = '' }: { size?: number; active?: boolean; className?: string }) {
  return <span className={`atomic-mark ${active ? 'is-active' : ''} ${className}`.trim()} style={{ width: size, height: size }} aria-hidden="true">
    <svg viewBox="0 0 48 48" role="presentation">
      <ellipse cx="24" cy="24" rx="20" ry="7.4"/>
      <ellipse cx="24" cy="24" rx="20" ry="7.4" transform="rotate(60 24 24)"/>
      <ellipse cx="24" cy="24" rx="20" ry="7.4" transform="rotate(120 24 24)"/>
      <circle className="atomic-nucleus" cx="24" cy="24" r="4.2"/>
      <circle className="atomic-electron electron-one" cx="44" cy="24" r="2.25"/>
      <circle className="atomic-electron electron-two" cx="14" cy="6.7" r="2.25"/>
      <circle className="atomic-electron electron-three" cx="14" cy="41.3" r="2.25"/>
    </svg>
  </span>;
}
