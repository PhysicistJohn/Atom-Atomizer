# ADR 0003: Instrument visual language

Status: accepted for foundation

## Decision

The application uses a purpose-built RF instrument language rather than a generic dashboard: near-black green-neutral surfaces, restrained mint trace/accent, amber evidence/detection state, red reserved for RF danger/faults, monospaced measurement numerals, compact navigation, high information density, and generous plot area.

Visual polish must not undermine measurement integrity or accessibility. Color is never the sole status carrier. Generator output remains globally visible. Plots distinguish current/stale/simulated data. Motion is functional and reduced-motion preferences are honored when animations are introduced. No remote fonts or UI assets are loaded.

The initial SVG trace is a correctness prototype. Plot-library selection is gated on measured ZS407 throughput, waterfall performance, high-DPI clarity, keyboard interaction, and bounded memory.
