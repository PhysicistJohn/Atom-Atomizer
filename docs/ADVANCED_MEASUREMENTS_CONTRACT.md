# Advanced swept-measurement contract

Status: implemented baseline  
Version: 1.0.0  
Updated: 2026-07-11

This document is normative for TinySA Atomizer Spectrum, Waterfall, Channel,
and Envelope STFT views. It defines what is calculated, which evidence supports
the result, how the UI remains bounded, and how Atom operates the same surface.

## Product baseline

The interaction model follows the common entry-spectrum-analyzer pattern rather
than any vendor's visual design:

- Keysight FieldFox groups Channel Power, Occupied Bandwidth, and ACPR under
  channel measurements. Channel Power integrates over an explicit bandwidth;
  OBW places bounds around a selected percentage of displayed power; ACPR
  reports the carrier in dBm and offsets in dBc.
- Rohde & Schwarz FPC exposes spectrum, channel power, occupied bandwidth,
  harmonic/time-domain measurements, and spectrogram as separate measurement
  modes. Its current FPC manual defines OBW as the bandwidth containing a
  selected percentage of total transmitted power.
- Anritsu MS2760A exposes Spectrum, Channel Power, OBW, and ACP as measurement
  types and Normal Spectrum/Spectrogram as views.

References are official primary documentation:

- Keysight FieldFox SA mode:
  https://helpfiles.keysight.com/csg/C_Series_FieldFox_WebHelp/Chapter_7_SA_%28Spectrum_Analyzer%29_Mode_%28Option_233%E2%80%93Mixed_Analyzers%29.htm
- Rohde & Schwarz FPC user manual, revision 12:
  https://scdn.rohde-schwarz.com/ur/pws/dl_downloads/pdm/cl_manuals/user_manual/1178_4130_01/FPC_UserManual_en_12.pdf
- Anritsu MS2760A Spectrum Master user guide:
  https://dl.cdn-anritsu.com/en-us/test-measurement/files/Manuals/Users-Guide/10580-00427M.pdf

TinySA Atomizer implements the transferable measurement workflow and vocabulary.
It does not copy vendor trade dress, claim numerical equivalence, or imply that
host calculations are firmware features.

## Evidence matrix

| View | Required evidence | Output | Qualification |
|---|---|---|---|
| Spectrum | One complete scalar sweep | Power versus RF frequency, traces, markers, metrics | Host display of measured bins |
| Waterfall | Complete scalar sweeps on one identical frequency grid | Power versus RF frequency and sweep age | Host spectrogram; no inter-sweep resampling |
| Channel | One complete scalar sweep plus explicit channel definition | CHP, PSD, ACP/ACLR, OBW | Scalar-sweep engineering estimate |
| Envelope STFT | One complete zero-span detected-power capture | Power versus time and modulation-frequency versus time | Detected envelope; explicitly not I/Q |

Every result identifies its source sweep/capture and evidence class. Missing or
incompatible evidence produces a visible error; another data source is never
substituted.

## Bounded measurement-stage contract

Spectrum owns one fixed-height `MeasurementWorkspace`. It contains:

1. one four-tab view bar (`Spectrum`, `Waterfall`, `Channel`, `Time / STFT`);
2. one active analysis canvas using all remaining height;
3. `Sweep setup` and `Traces & markers` overlays that do not reflow or lengthen
   the document;
4. the persistent application status bar and independent Atom rail.

Only the active view is rendered. Spectrum metrics occupy a fixed footer inside
the stage. No Spectrum workflow requires body or workspace scrolling. The
default Electron window is 1920 × 1100 CSS px, clamped to the primary display's
work area; minimum size is 1280 × 800 where the display permits it. Atom's open
rail remains reserved at the reference width.

The overlays may obscure measurement pixels temporarily because the operator
explicitly opened them. Closing an overlay returns the exact same plot state;
opening controls must not change acquisition or analysis state.

## Waterfall contract

`WaterfallConfiguration` contains:

- history depth from 5 through the global 50-sweep bound;
- finite floor and ceiling in dBm, with ceiling strictly greater than floor;
- the closed `atomic` palette identifier.

History is newest first. A frame is eligible only when its complete frequency
array exactly equals the newest frame's grid. Grid changes are counted and
reported as excluded; frames are never interpolated, stretched, or silently
mixed. Color mapping clamps only for display and never mutates stored dBm.

The vertical axis is sweep age, not clock time and not STFT time. Calling this
view a spectrogram is valid in the swept-SA sense; it must not be described as
an I/Q spectrogram.

## Channel-power and ACP contract

`ChannelMeasurementConfiguration` explicitly defines:

- main-channel center and integration bandwidth;
- adjacent-channel integration bandwidth;
- center-to-center channel spacing;
- one, two, or three lower/upper offset pairs;
- percent power for OBW;
- OBW noise treatment: none or robust-floor subtraction.

Adjacent and main windows may touch but may not overlap. Every configured window
must lie inside the actual acquired span.

When the staged analyzer span changes, the application first retains a channel
definition whose complete main/adjacent extent still fits with margin. A stale
out-of-span definition is recentered on the new analyzer span; if its extent is
too large, main/adjacent bandwidth and spacing are deterministically bounded
while preserving non-overlap and adjacent-channel count. This is staged UI
geometry, not a substitute for evidence validation: the calculation still fails
if any resulting window lies outside the actual returned sweep endpoints.

Each trace point is treated as detected power through the measured RBW. The
frequency cell for an interior bin is bounded by the midpoints to its neighbors;
endpoint cells terminate at actual sweep start/stop. Integrated milliwatts are:

```text
sum(bin milliwatts × overlap Hz / actual RBW Hz)
```

The result returns integrated dBm, average dBm/Hz, and the number of contributing
bins. ACP/ACLR is `offset power dBm - carrier power dBm` and is reported in dBc;
absolute offset power remains available in dBm. Orders 2 and 3 are alternate and
extended offsets rather than invented protocol-specific labels.

This estimator requires a finite positive measured RBW and strictly increasing
frequency points. It does not hide undersampling, receiver-shape, detector,
calibration, or sweep-time uncertainty; results remain `engineering-estimate`
until the physical ZS407 path is characterized.

## Occupied-bandwidth contract

OBW is the frequency interval between equal-power tails that contains the
configured percentage of total integrated power over the displayed sweep.
Allowed percentage is 10 through 99.9.

- `none` integrates all displayed scalar power.
- `robust-floor` subtracts the robust median-floor estimate from every bin in
  linear milliwatts and clamps negative residuals to zero.

The selected treatment is returned and displayed. Robust-floor subtraction is a
host visualization/engineering aid, not a standards-conformance default. Strong
adjacent emissions can legitimately expand OBW because total displayed power is
the integration domain.

## Envelope STFT contract

`EnvelopeStftConfiguration` contains a Hann window of 16, 32, 64, 128, or 256
samples; an explicit hop no greater than the window; optional mean/DC removal;
and 20–120 dB display range.

Input dBm is converted to linear milliwatts. Each frame is mean-corrected when
requested, Hann-windowed, and transformed with a deterministic real DFT. The
nonnegative frequency bins run from DC through envelope Nyquist. Magnitudes are
normalized to the strongest coefficient in the complete capture solely for
display. The dominant modulation frequency is selected from integrated squared
magnitude, excluding DC when mean removal is enabled.

The operation fails when the capture is incomplete, has non-finite values or an
invalid sample period, contains fewer samples than the window, or has no
measurable variation after correction.

Envelope STFT may support AM/burst/pulse-rate inspection. It cannot recover RF
phase, complex symbols, constellation, EVM, frequency error, demodulated audio,
or protocol identity. Those require a characterized I/Q acquisition path that
the current USB contract does not expose.

## Atom contract

Every view and calculation has a preferred typed hook:

| Tool | Contract |
|---|---|
| `set_measurement_view` | Select one of the four bounded views |
| `configure_waterfall` | Set depth and explicit dBm color bounds |
| `configure_channel_measurement` | Set the complete channel definition |
| `get_channel_measurement_results` | Return CHP/PSD/ACP/OBW or fail |
| `configure_envelope_stft` | Set the complete STFT definition |
| `get_envelope_stft_results` | Return the latest envelope STFT or fail |
| `acquire_envelope_stft` | Acquire staged zero-span evidence and analyze it |

Semantic computer controls can select each view. Typed tools are preferred for
state and calculations; screenshot/click operation remains available for visual
inspection. Atom's application context contains the active view, complete
configuration, result or explicit analysis error, and evidence labels.

## Explicitly gated measurements

The current contract does not render a control for a measurement that lacks an
honest implementation. The following are separate future work packages:

- editable limit lines and spectrum-emission masks;
- multi-sweep harmonic distortion and TOI orchestration;
- carrier-to-interference workflows with an explicit reference definition;
- calibrated field strength using antenna/cable correction tables;
- phase noise, noise figure, vector demodulation, EVM, CCDF/APD, and I/Q STFT.

No generic “advanced” menu or disabled placeholder stands in for those
contracts.

## Acceptance inventory

- `ADV-001`: Spectrum workspace has no body/workspace scroll at 1920 × 1100 with Atom open.
- `ADV-002`: only one analysis view owns the measurement canvas.
- `ADV-003`: setup and measurement controls overlay without changing stage height.
- `ADV-004`: waterfall retains at most 50 frames and excludes mismatched grids visibly.
- `ADV-005`: waterfall color bounds reject inverted or non-finite ranges.
- `ADV-006`: band integration uses linear power, actual RBW, and cell overlap.
- `ADV-007`: any channel window outside actual span fails the complete calculation.
- `ADV-008`: ACP returns absolute dBm and signed relative dBc for each side/order.
- `ADV-009`: OBW percent and noise treatment round-trip through schema, UI, storage, and Atom.
- `ADV-010`: envelope STFT detects a deterministic bin-centered modulation fixture.
- `ADV-011`: envelope STFT never carries an I/Q qualification.
- `ADV-012`: every visible analysis view has a typed Atom selection/config/result path.
- `ADV-013`: reference screenshots cover populated Spectrum, Waterfall, Channel, and Envelope STFT.
- `ADV-014`: Classification uses a fixed-height pipeline/result-candidate/envelope composition; the document never scrolls and empty/result evidence remains visible with Atom open.
- `ADV-015`: analyzer-span changes reconcile stale channel geometry before render while actual-endpoint validation remains fail-closed.
- `ADV-014`: invalid evidence produces a visible/typed error and never a substituted result.
