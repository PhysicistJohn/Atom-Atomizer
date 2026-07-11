# Spectrum measurement controls contract

Status: implementation baseline  
Version: 2.1.0  
Updated: 2026-07-10

This document is normative for TinySA Atomizer marker, trace, amplitude-display,
and trigger behavior. It deliberately separates capabilities visible in the
pinned ZS407 firmware from simultaneous measurements derived by the desktop from
complete acquired sweeps.

## Truth boundary

The pinned tinySA4 source defines `MARKER_COUNT = 8` and `TRACES_MAX = 4`. Its
`marker` shell command exposes marker enable, peak, delta, noise, tracking, trace
assignment, trace averaging, fixed-frequency, and fixed-index operations. Its
`trace` shell command exposes four trace slots, units, scale/reference level,
copy/freeze/subtract/view, and trace-value access.

That firmware surface is recorded in `DeviceCapabilities`; it is not treated as
a dependable complete-state API. In particular, the shell's trace query does
not round-trip every trace state sufficiently to reconstruct a simultaneous
desktop trace bank. Atomizer therefore calculates its four displayed traces and
eight marker readouts from the exact host sweep arrays. The UI labels this
`HOST MATH`. It never presents host state as firmware readback.

## Trace-bank contract

`TraceBankConfiguration` contains exactly four uniquely identified traces. The
initial bank is T1 Clear / Write and T2–T4 Blank. Each `TraceFrame` identifies its
source trace, mode, exact frequency grid, power array, source sweep ID,
accumulated sweep count, and host-derived provenance.

| Mode | Required bin operation | Retained memory |
|---|---|---|
| Clear / Write | Replace every bin with the latest complete sweep | Latest frame |
| Max Hold | Maximum dBm observed independently at every bin | Since reset/grid change |
| Min Hold | Minimum dBm observed independently at every bin | Since reset/grid change |
| Average | Rolling mean of linear milliwatt power, converted back to dBm | Configured 2–100 sweeps |
| View / Freeze | Preserve the last valid accumulated frame | Yes |
| Blank | Do not render; preserve its accumulated frame | Yes |

Changing the frequency grid or point count invalidates prior binwise memory and
starts a new accumulation. Switching from Blank or View back to its retained
accumulation mode resumes only when the grid is identical; selecting a different
accumulation mode begins a new frame. Reset
clears one trace without mutating the other three. Incomplete or mismatched
sweeps never enter any accumulator.

This vocabulary aligns with the common Clear/Write, Max Hold, Min Hold, Average,
View, and Blank workflows documented by Keysight and Rohde & Schwarz; it does
not imply command or numerical equivalence to those instruments.

## Marker contract

There are exactly eight marker configurations. A marker contains an ID, enabled
state, assigned trace, frequency, readout mode, tracking mode, and optional delta
reference. M1 starts enabled and peak-tracking on T1; M2–M8 start disabled.

Marker frequency is always snapped to the nearest actual bin of its assigned
`TraceFrame`. Markers on Blank traces or traces without a frame have no reading.
Clicking or dragging on the plot places the active marker on an actual bin and
changes tracking to Fixed.

| Readout | Calculation |
|---|---|
| Normal | Assigned trace frequency and dBm at the nearest bin |
| Delta | Frequency difference and dB power difference from the selected reference marker |
| Noise density | `bin dBm - 10 log10(actual RBW Hz)`, labeled dBm/Hz |

Noise-density readout is a host normalization of detected bin power. It is not a
phase-noise or calibrated noise-figure measurement. A missing/invalid actual RBW
fails the readout rather than substituting requested RBW.

Peak tracking places the marker at the global maximum on every complete frame.
Manual searches support global Peak, global Minimum, Next Left, and Next Right.
Directional searches consider local maxima above the configured absolute
threshold and minimum excursion. If no qualifying candidate exists, the search
fails visibly and leaves marker state unchanged.

## Display and trigger contract

The amplitude display is host-owned and contains a reference level, exactly ten
vertical divisions, and a scale of 1, 2, 5, 10, or 20 dB/div. Auto Scale computes
a readable 1/2/5-family scale from the latest complete sweep. Changing display
scale never reconfigures the analyzer and never alters stored dBm arrays.

Analyzer trigger configuration remains firmware-commanded through the typed
analyzer contract: Auto, Normal, or Single, with an explicit dBm level where
required. Trigger settings are shown with acquisition physics rather than mixed
into host trace math.

## UI and Atom contract

The closed command bar always reports active marker count, visible trace count,
scale, up to four live marker readouts, and `HOST MATH`. Opening Markers, Traces,
or Display expands one surface at a time. The 1580 × 948 reference viewport must
have no clipped input, overlapping label, or horizontal overflow with Atom open.

Atom receives typed tools for `get_measurement_state`, `configure_marker`,
`search_marker`, `configure_trace`, `reset_trace`, and
`configure_spectrum_display`. These execute the same reducers as the visual
controls. Screenshot/computer operation remains available for UI inspection but
is not a substitute for the typed measurement tools.

## Acceptance

- `MEAS-001`: the trace bank rejects missing, duplicate, or out-of-range trace IDs.
- `MEAS-002`: Max Hold and Min Hold are binwise across complete identical grids.
- `MEAS-003`: Average is performed in linear power, never directly in dBm.
- `MEAS-004`: View and Blank retain memory; Reset clears only the selected trace.
- `MEAS-005`: a grid or point-count change starts a new accumulation.
- `MEAS-006`: all marker readings bind to exact bins of their assigned trace.
- `MEAS-007`: delta and noise-density calculations preserve explicit units.
- `MEAS-008`: directional search fails loudly when no qualifying peak exists.
- `MEAS-009`: plot click/drag, panel control, and Atom tool produce the same marker state.
- `MEAS-010`: the reference viewport renders every expanded panel without overflow.
- `MEAS-011`: local persistence round-trips only schema-valid measurement state.
- `MEAS-012`: host projections are never described as firmware-verified state.

## References

- Pinned firmware: sibling `TinySA_Firmware`, commit
  `c97938697b6c7485e7cab50bca9af76996b7d671`, `main.c` marker/trace commands.
- Keysight trace types:
  https://helpfiles.keysight.com/csg/FFProgrammingHelpWebHelp/TRACe_SPECtrum_1_2_3_4_TYPE.htm
- Keysight marker configuration:
  https://helpfiles.keysight.com/csg/BenchVueSoftware_HDML5HelpFiles/SAApp/English/Content/GUI/Instrument%20Settings%20Tab/Settings%20Panes/Markers%20Configuration%20Pane.htm
- Keysight marker search/tracking:
  https://helpfiles.keysight.com/csg/e5055a/S4_Collect/Markers.htm
- Rohde & Schwarz FPC trace/detector workflows:
  https://scdn.rohde-schwarz.com/ur/pws/dl_downloads/dl_common_library/dl_manuals/dl_user_manual/FPC_UserManual_en_12.pdf
