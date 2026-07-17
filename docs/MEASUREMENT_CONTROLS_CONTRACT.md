# Spectrum measurement controls contract

Status: implementation baseline  
Version: 2.5.0
Updated: 2026-07-16

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
a dependable complete-configuration API. The shell summary does identify
enabled trace IDs and the value command returns indexed points, so Atomizer
reads and exactly validates those values as a separate `FirmwareTraceFrame`
bank. Missing configuration properties remain `unknown`. Device frames are
exposed as `D1..D4` with `firmware-readback` provenance. Their plot overlays
are off by default and controlled independently from the host trace bank;
visibility never commands, clears, or relabels a firmware trace.

Atomizer also calculates four host traces and eight marker readouts from the
exact host sweep arrays. Those render as `H1..H4` with `host-derived`
provenance. Host and device trace banks are never merged or relabeled.

## Trace-bank contract

`TraceBankConfiguration` contains exactly four uniquely identified traces. The
initial bank is T1 Clear / Write and T2–T4 Off (`blank`). Each `TraceFrame` identifies its
source trace, mode, exact frequency grid, power array, source sweep ID,
accumulated sweep count, and host-derived provenance.

| Mode | Required bin operation | Retained memory |
|---|---|---|
| Clear / Write | Replace every bin with the latest complete sweep | Latest frame |
| Max Hold | Maximum dBm observed independently at every bin | Since reset/grid change |
| Min Hold | Minimum dBm observed independently at every bin | Since reset/grid change |
| Average | Rolling mean of linear milliwatt power, converted back to dBm | Configured 2–100 sweeps |
| View / Freeze | Preserve the last valid accumulated frame | Yes |
| Off (`blank`) | Do not render; preserve its accumulated frame | Yes |

Changing any staged analyzer acquisition configuration invalidates displayed
host/device frames, history, detections, and classifications before a new sweep
can be admitted. The accumulator also rejects grid-incompatible memory.
Switching from Off or View back to its retained
accumulation mode resumes only when the grid is identical; selecting a different
accumulation mode begins a new frame. Reset
clears one trace without mutating the other three. Incomplete or mismatched
sweeps never enter any accumulator. A frame whose paired frequency/power arrays
are mismatched, nonfinite, nonincreasing, or physically degenerate is
quarantined before measurement reducers or plot projection; malformed evidence
cannot emit invalid SVG geometry or reach marker placement.

This vocabulary aligns with the common Clear/Write, Max Hold, Min Hold, Average,
View, and Blank/Off workflows documented by Keysight and Rohde & Schwarz; it does
not imply command or numerical equivalence to those instruments.

## Marker contract

There are exactly eight marker configurations. A marker contains an ID, enabled
state, assigned trace, frequency, readout mode, tracking mode, and optional delta
reference. M1–M8 all start disabled and fixed on H1. The exact untouched legacy
default (M1 enabled/peak, M2–M8 disabled) migrates once to the all-off bank;
edited banks are preserved.

Marker frequency is always snapped to the nearest actual bin of its assigned
`TraceFrame`. Markers on Off traces or traces without a frame have no reading.
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

Peak first selects the globally strongest threshold component on every complete
frame. A narrow, censored, or unqualified response stays on its true sampled
maximum. A bounded broad component instead snaps to the nearest measured bin to
its noise-subtracted linear-power centroid. This remains valid when one
threshold-connected response has several disjoint half-power islands: the center
uses the complete bounded component while contiguous 3 dB width stays explicitly
unavailable. Components separated at the admission threshold are never merged.
A one-resolution-element crest that contains at least half of the component's
integrated noise-subtracted power remains a narrow sampled-peak response rather
than inheriting a weak broad pedestal's width. CW-like narrow responses
therefore stay on their actual sampled maximum; any available observed width is
resolution-limited, while missing bounded crossings remain unavailable.
Centroid placement is reserved for bounded broad components. Global Minimum is unconditional. Only Next Left and Next
Right apply the configured absolute threshold and minimum excursion. If no
directional candidate exists, the search fails visibly and leaves marker state
unchanged.

### Marker-local response characterization

Every marker reading also carries a characterization derived from the complete
assigned host trace. This calculation is independent of protocol or SignalLab
profile labels. Detector rows are annotation-only and cannot expand, contract,
or shift the trace-local component used for width or center.

The host estimates a robust lower-tail floor, an evidence-local variability
scale, and a required prominence gate of at least 10 dB. It finds
threshold-connected components after bridging gaps no wider than one coarser
RBW/grid resolution element. A fixed marker uses the component containing its
bin, or the nearest threshold component with explicit distance. Failure to
clear the component or local-prominence gate returns `unavailable` and no 3 dB
width. This is an engineering candidate gate, not a calibrated false-alarm
probability.

For a monotone or narrow admitted component, the sampled maximum is the
half-power reference. A rippled wide component uses its 90th-percentile robust
upper envelope instead. Interior upper-envelope notches may be closed only when
they span no more than four resolution elements inside the same threshold
component; threshold connectivity itself still bridges at most one element, so
components separated by a floor gap wider than one element are not merged, while
a one-element gap is explicitly unresolved by policy. Remaining disjoint
half-power islands fail closed as nonmonotone for contiguous 3 dB width, without
discarding the independently qualified bounded-component power centroid.
Observed crossings are interpolated in dB versus frequency. The response is:

- `resolution-limited-narrow` when the observed crossing width is no more than
  two elements of `max(actual RBW, nominal grid spacing)`;
- `resolved-wideband` when the observed local response exceeds two such
  elements; or
- `unavailable` when a lower/upper crossing is not observed, lies outside the
  bounded local window, or local evidence does not clear the gate.

Orthogonally to 3 dB availability, every prominence-qualified threshold
component carries a 99% component OBW. It integrates robust-floor-subtracted
linear power with the actual frequency-cell widths and measured RBW, and trims
0.5% from each cumulative-power tail. Its bounds never leave the selected
threshold component's sample cells, never use detector bounds, and never join a
different threshold component. This component OBW is omitted when component or
prominence qualification fails, but not merely because a contiguous half-power
crossing is truncated or nonmonotone. A centroid-qualified bounded broad
component likewise keeps its power centroid when disjoint half-power islands
make contiguous 3 dB width unavailable; missing/truncated crossings do not by
themselves turn an unbounded response into a centroid-qualified component.
Within those independent component-qualification rules, centroid and component
OBW are orthogonal outputs to contiguous 3 dB status; neither substitutes for a
missing width.

The result is the observed scalar receiver response. Neither its 3 dB width nor
its explicitly separate component OBW is deconvolved emitter bandwidth,
whole-span OBW, or a protocol-wide allocation.
In particular, the SignalLab Bluetooth 79/80 MHz fields describe aggregate
frequency support; a marker reports only the currently observed local hop or
advertisement response. `peakToRobustFloorDb` and `prominenceDb` are exposed as
signal/noise context. Neither is labeled calibrated SNR.

Current candidate or active frequency-local detector rows may be attached as
bounded context: the row either contains the local peak or is explicitly the
nearest current row with a distance. Detector context is not a prerequisite and
never changes support, center, or width, so a complete first sweep can still
produce an honest trace-local result before tracker promotion.

The 3 dB field follows the common N-dB-down interaction and never uses the
separate component OBW as a surrogate. The R&S FPC documents a reference marker plus temporary left/right
markers at N dB down, while the R&S FSG explicitly shows dashes when noise
prevents a spacing result. Keysight's E5061B bandwidth search likewise reports
the low/high cutoff points and treats missing crossings as unavailable.

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

The `Traces & markers` action opens one right-edge active-function drawer inside
the bounded measurement stage. Its tab row always reports active marker count,
visible trace count, and display scale. Markers shows one selected marker,
its live readout, and search controls; Traces shows one selected trace; Display
shows amplitude controls. Opening Markers, Traces, or Display replaces the
current drawer surface without changing document or stage height. Values follow
the shared one-value-per-row contract in `UI_UX_CONTRACTS.md`. The 1920 × 1100
reference viewport must have no clipped input, overlapping label, horizontal
overflow, or workspace scroll with Atom open.

Atom receives typed tools for `get_measurement_state`, `configure_marker`,
`search_marker`, `configure_trace`, `configure_firmware_trace_visibility`, `reset_trace`, and
`configure_spectrum_display`, plus the advanced view tools governed by
`ADVANCED_MEASUREMENTS_CONTRACT.md`. These execute the same reducers as the
visual controls. Screenshot/computer operation remains available for UI
inspection but is not a substitute for the typed measurement tools.

The active marker measurement card occupies a dedicated structural row between
the spectrum header and plot canvas. It is never absolutely positioned over or
inside the SVG trace plane. The live trace, marker stem, and unfilled two-edge
3 dB bracket remain SVG. The `M1` tag and diamond are a fixed-pixel HTML overlay
in a reserved data-viewport headroom row, vertically aligned at the exact marker
frequency with the tag above the diamond and both above the trace. The data SVG
and overlay share fixed left/right edge insets so exact start/stop markers are
not clipped or stretched on non-square plots.

## Acceptance

- `MEAS-001`: the trace bank rejects missing, duplicate, or out-of-range trace IDs.
- `MEAS-002`: Max Hold and Min Hold are binwise across complete identical grids.
- `MEAS-003`: Average is performed in linear power, never directly in dBm.
- `MEAS-004`: View and Off retain memory; Reset clears only the selected trace.
- `MEAS-005`: a grid or point-count change starts a new accumulation.
- `MEAS-006`: all marker readings bind to exact bins of their assigned trace.
- `MEAS-007`: delta and noise-density calculations preserve explicit units.
- `MEAS-008`: directional search fails loudly when no qualifying peak exists.
- `MEAS-009`: plot click/drag, panel control, and Atom tool produce the same marker state.
- `MEAS-010`: the reference viewport renders every expanded panel without overflow.
- `MEAS-011`: local persistence round-trips only schema-valid measurement state.
- `MEAS-012`: host projections are never described as firmware-verified state.
- `MEAS-013`: enabled D1–D4 frames require unique firmware IDs, exact contiguous indices, finite dBm values and the complete acquired point count.
- `MEAS-014`: H1–H4 and D1–D4 remain visually and semantically distinguishable even when their curves coincide.
- `MEAS-015`: all eight markers are off by default and the exact legacy untouched default migrates without rewriting edited banks.
- `MEAS-016`: every host trace has an explicit operator-facing Off action; an empty host frame bank never falls back to an implicit H1 curve.
- `MEAS-017`: D1–D4 visibility is explicit, defaults off, is separately agent-operable, and never mutates firmware trace state.
- `MEAS-018`: a sweep whose `requested` analyzer configuration differs from the latest staged revision is quarantined before history, trace, detection, or classification reducers.
- `MEAS-019`: marker-local width classification depends only on assigned-trace half-power crossings and the RBW/grid resolution scale, never a protocol/profile label or 99% OBW.
- `MEAS-020`: no-component, insufficient-prominence, lower/upper-truncated, and out-of-window cases expose an unavailable reason and never invent a 3 dB width or SVG bracket.
- `MEAS-021`: marker signal/noise context is labeled peak-to-robust-floor and prominence, never calibrated SNR.
- `MEAS-022`: marker characterization works from one complete trace without a promoted detector row; any candidate/active row is separately labeled bounded context.
- `MEAS-023`: the active marker card is a sibling gutter outside the SVG/plot canvas and remains readable for left, center, and right peaks.
- `MEAS-024`: Bluetooth aggregate support metadata never substitutes for a local hop/advertisement response width.
- `MEAS-025`: every `TraceFrame` retains its exact actual RBW and qualification; an active accumulator resets when either changes, while View keeps the frozen frame's own provenance until accumulation resumes.
- `MEAS-026`: Peak, Atom output, stored marker configuration, marker reading, and rendered diamond bind to the same exact measured bin, including fractional-Hz grids.
- `MEAS-027`: detector rows are annotation-only and cannot alter marker support, center, 3 dB width, or component OBW.
- `MEAS-028`: every prominence-qualified threshold component exposes a separate 99% robust-floor-subtracted, frequency-cell-weighted component OBW; unqualified and floor-separated components are never folded into it.
- `MEAS-029`: host/device traces are projected from their paired physical frequencies; malformed, nonfinite, nonincreasing, or degenerate evidence is quarantined without invalid SVG geometry or a renderer crash.

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
- [Rohde & Schwarz FPC User Manual — Signal bandwidth measurement, N dB Down](https://scdn.rohde-schwarz.com/ur/pws/dl_downloads/pdm/cl_manuals/user_manual/1178_4130_01/FPC_UserManual_en_12.pdf)
- [Rohde & Schwarz FSG Operating Manual — Measurement of the Filter or Signal Bandwidth](https://scdn.rohde-schwarz.com/ur/pws/dl_downloads/dl_common_library/dl_manuals/dl_user_manual/FSG_OperatingManual_en_FW469.pdf)
- [Keysight E5061B — Measurement Example of a Bandpass Filter](https://helpfiles.keysight.com/csg/e5061b/quick_start_guide/s-parameter_measurement/measurement_example_of_a_bandpass_filter.htm)
