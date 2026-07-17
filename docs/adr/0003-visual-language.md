# ADR 0003: Instrument visual language

Status: accepted for foundation

## Decision

The application uses a purpose-built RF instrument language rather than a generic dashboard: near-black green-neutral surfaces, restrained mint trace/accent, amber evidence/detection state, red reserved for RF danger/faults, monospaced measurement numerals, compact navigation, high information density, and generous plot area.

Visual polish must not undermine measurement integrity or accessibility. Color is never the sole status carrier. Generator output remains globally visible. Plots distinguish current/stale/simulated data. Motion is functional and reduced-motion preferences are honored when animations are introduced. No remote fonts or UI assets are loaded.

Spectrum remains a live React-driven SVG projection: each admitted sweep, trace,
marker, display, and Detect-overlay change recomputes bounded geometry from the
current validated state. The SVG is a drawing primitive, not a static asset or
measurement store. The measured update stress, fixed DOM size, high-DPI clarity,
and keyboard/marker behavior satisfy the current scalar-sweep contract. Canvas or
WebGL is reconsidered only if measured hardware throughput or a larger future data
surface exceeds that contract; Waterfall continues to use its bounded canvas
history renderer.
