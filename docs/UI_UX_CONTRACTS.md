# Atomizer UI/UX and Analysis Contracts

Status: execution baseline  
Version: 2.3.0
Updated: 2026-07-17

This document is normative. It decomposes the desktop experience into testable contracts. `PLAN.md` defines the product outcome; `CONTRACTS.md` defines program work packages; this file defines what each operator workflow, screen, component, state, and analysis mode must do.

## 1. Product experience contract

The product is an RF instrument, not a dashboard. It must let an operator answer, in order:

1. Which instrument am I controlling?
2. What mode is it in?
3. Is RF output possibly active?
4. What configuration will the next operation use?
5. Is the displayed data live, stale, simulated, saved, or inferred?
6. What happened, with what settings, and can it be reproduced?

No screen may obscure the answers to questions 1–3. Measurement views must answer 4–6 without relying on hover-only content.

### 1.1 Experience principles

| ID | Principle | Enforceable rule |
|---|---|---|
| XP-01 | Instrument truth | Requested, commanded, verified, stale, simulated, and unknown states are visually and semantically distinct. |
| XP-02 | Safe by construction | No navigation, import, reconnect, preset, or configuration action may enable RF output. |
| XP-03 | Plot first | The primary measurement plot receives the largest uninterrupted area at the reference window size. |
| XP-04 | Progressive density | Common controls are visible; advanced controls are grouped without hiding current effective values. |
| XP-05 | Evidence over certainty | Detection and classification results carry source sweeps, settings, timestamps, source identity/qualification, device/firmware when applicable, and confidence/evidence. |
| XP-06 | Recoverable interruption | Unplug, timeout, cancellation, window reload, and invalid input end in an actionable state without an indefinite spinner. |
| XP-07 | Local and private | No remote font, asset, telemetry, inference, or account dependency exists in v1. |
| XP-08 | Keyboard complete | Every core workflow is achievable without a pointer. |
| XP-09 | Active functions | Every editable instrument value is a readable, full-row active function before it becomes an input. |
| XP-10 | Chromatic restraint | Application chrome is neutral; color identifies selection, state, risk, Atom, or measured data rather than decorating every surface. |

## 2. Information architecture

### 2.1 Persistent application frame

The frame contains five regions:

- **Top bar:** product identity, environment/update badges, instrument connection control, and Atom entry point.
- **Primary navigation:** one sidebar group contains the six core routes Spectrum, Waterfall, Channel, Detect, Generate, and Device. It adds I/Q only when the active session advertises complex samples. A separate persistent acquisition rail in the same sidebar exposes the global swept-data Run/Single/Stop state on every route. Spectrum has no top or nested measurement-view tab bar, and unfinished destinations are not rendered as dead affordances.
- **Workspace:** route-specific header, actions, errors, connection guidance, content and inspector.
- **Status bar:** connection, driver/source kind, qualification, device/firmware when applicable, trace state, verification state, instrument API version.
- **Atom rail:** native voice/text agent, tool activity, approvals, and instrument-aware suggestions.

These regions remain mounted across workspace changes. Generator output `on` or `unknown` must remain visible in the navigation and top-level status treatment regardless of active workspace.

On macOS the main window uses the same native `hiddenInset` chrome as Signal
Lab. Traffic-light controls occupy a reserved leading area inside the draggable
top bar; brand and controls may not overlap them. Other platforms retain native
window controls without the macOS-only inset spacing.

Atom is governed by `AI_NATIVE_CONTRACTS.md`. At the 1920×1100
work-area-clamped reference size it is a detached intelligence layer and the
workspace reserves its full footprint, so the active trace is never hidden.
Below the reference width Atom becomes an explicit overlay that the operator can
close; it must not silently cover a high-impact approval or RF state. Realtime
voice connects once at startup with the microphone muted. The independent mic
and speaker buttons encode disconnected, connected-muted, connected-live,
speaking, and error states; a redundant microphone connection button is absent.

### 2.2 Workspace routes

| Route | ID | Primary outcome | v1 status |
|---|---|---|---|
| Spectrum | WS-SPC | Configure and acquire a trace | Core |
| Waterfall | WS-WTR | Inspect coherent sweep history on one exact frequency grid | Core |
| Channel | WS-CHN | Measure channel power/PSD, local 3 dB response width, ACP/ACLR, and OBW | Core |
| Detect | WS-DET-CLS | Find current emissions and infer open-set-oriented scalar-observable evidence classes in one synchronized surface | Detection core; experimental fixed empirical Bayesian classification core; physical calibration and protocol identity gated |
| I/Q | WS-IQ | Configure and inspect one bounded, capability-declared complex-sample capture | Complete-buffer core; continuous streaming not implemented |
| Generate | WS-GEN | Operate the embedded SignalLab Studio for a SignalLab source, or configure and deliberately enable RF output for a generator-capable source | Studio core; physical-generator qualification pending |
| Device | WS-DEV | Inspect identity/telemetry and operate screen capture/touch | Core; physical diagnostics/capture accepted, touch qualification pending |

Spectrum, Waterfall, and Channel are first-class labels in the one sidebar group and share one bounded measurement controller and stage. They are not nested tabs. Detect is the user-facing name of the merged detector/classifier workspace. I/Q is a separate capability-gated route and is not a second interpretation of scalar zero span. Run/Single/Stop are not owned by any route: their persistent sidebar rail owns continuous/single swept-data collection and remains visible while another workspace is inspected. Complete-buffer I/Q capture remains an explicit I/Q action and does not imply continuous I/Q streaming. Durable saved sessions, comparison, settings, and support-bundle workflows remain contracted work, but are omitted from navigation until functional. The measurement controller retains 50-sweep history and native CSV/JSON export; export controls remain contextual to that measurement rather than joining the acquisition rail.

Workspace availability and controls are derived from the active session's declared capabilities. SignalLab supports swept spectrum, detected power, its typed profile/channel feature, and bounded deterministic complex-I/Q for all 34 closed profiles. CW, AM, and FM are analytic laboratory envelopes; the other 31 are standards-derived engineering envelopes. It does not expose an RF generator, firmware screen/touch, or TinySA diagnostics. The physical ZS407 and Firmware twin expose only the features proved by their admitted capability profile. A route that has no meaningful capability for the active source shows a specific unavailable state and source-switch action; it never sends a TinySA-only request to SignalLab or fabricates a generic setting.

Generated Bayesian classifier assets are optional at desktop startup. When the
asset pair is absent or rejected by its runtime contract, Detect shows
`Classification unavailable` and returns explicit `unknown` with
`model-unavailable`; only classification actions are disabled. The desktop,
instrument admission, acquisition, detector controls/localization, Spectrum,
Waterfall, Channel, Generate, and Device remain mounted and governed by their
independent source-capability boundaries.

### 2.3 Instrument selection, SignalLab, and the executable twin

Atomizer discovers each statically registered driver independently and retains driver-scoped failures. Main loads an owner-only version-1 preference; every new write persists `{driverId,candidateKind,candidateId}`. When no preference file exists, the exact `signal-lab:default` candidate is the explicit factory default. Legacy v1 broad records remain readable but fail on ambiguity, while a stale exact candidate ID fails closed. The connection surface identifies every candidate by driver, source kind, display name, and truthful capability summary. It connects exactly one preferred match. A corrupt preference, no match, ambiguity, discovery/identity/bridge/evidence failure, or connection failure is actionable and never falls through to a different driver, source kind, or candidate. Changing the default is an explicit operator action after safe disconnection.

SignalLab remains a separate repository and application in `../Atom-SignalLab`, but its separately built version-1 NDJSON measurement bridge is now the active high-level source behind Atomizer's `signal-lab` driver. The UI identifies it as `SIGNALLAB · SYNTHETIC VISUAL PROJECTION` and never labels it as a TinySA, USB device, executable firmware, or RF emitter. Selecting Generate mounts the shared controlled SignalLab Studio with `LAB`, `GSM`, `LTE`, `5G NR`, `WI-FI`, and `BLUETOOTH` tabs, complete admitted descriptor/source disclosures, and AWGN/Rayleigh channel controls. The Atomizer driver remains the state owner; the shared component has no independent bridge or preload access. Studio source-truth controls are human-only and do not silently extend Atom's tool authority.

SignalLab's selected profile is visible source status, not classifier truth: it never appears in a scalar measurement, detector input, classifier input, result rationale, or exported observation provenance. Profile or channel changes invalidate the admitted acquisition configuration before the next acquisition. Bridge failure is visible and cannot activate hardware or the twin. SignalLab advertises I/Q for all 34 closed profiles. Laboratory captures retain `analytic-complex-baseband`; standards-labelled captures retain `standards-derived-complex-baseband` and must be presented as engineering envelopes, not packet-decodable or conformance vectors.

The `tinysa-zs407` driver exposes physical ZS407 and executable-twin candidates as separate source kinds. Neither suppresses nor substitutes for the other. A physical candidate must pass exact USB, cross-response ZS407, parseable firmware version/revision, and command-catalog admission. Only an exact registered OEM version/revision/full-source-commit mapping receives supported-OEM provenance; a syntactically valid unknown revision is shown persistently as `CUSTOM FW · UNQUALIFIED`, with no invented source commit or qualification. The separate exact frozen custom receiver record is shown as `CUSTOM FW · RECEIVE ONLY`, displays its full-source mapping and persistent unattested-binary/non-OEM warning, and exposes no RF-output status or Generator authority. The twin boots the sibling Firmware repository's pinned Renode image. The UI must say `DIGITAL TWIN`, show boot/identity progress, preserve `transport=renode-monitor-bridge`, and state that USB transactions are not modeled. The initial physical receive-only evidence remains characterization, not RF calibration or general hardware qualification.

The renderer displays only main-owned RF session state. Physical `on`/`off` is labeled command-acknowledged, twin state is labeled firmware-executed-twin, and neither may be presented as calibrated RF measurement. `unknown` is a risk state, not an indeterminate visual preference: acquisition and unsafe actions remain unavailable until explicit output-off recovery. Firmware-screen touch invalidates the current acquisition configuration and RF state. Stale-session events, stale SignalLab producer epochs, and any response or event that fails runtime validation cannot alter visible state.

SignalLab's immutable canonical scalar corpus remains a pinned build-time source for the generated Bayesian observable model, separate from live source status. The active `SignalLab -> Atomizer` measurement edge does not activate the future `SignalLabStimulusIntent -> Firmware stimulus sink` edge. That edge remains `reserved-not-connected`; activating it requires a coordinated trio contract. The UI and Atom must present these edges separately and never imply a live generator-to-classifier side channel.

NeptuneSDR is not a current candidate, driver, or supported capability. The generic complex-I/Q v1 contract and renderer admit one complete buffer in the source-declared `cf32le`, `ci16le`, `ci8`, or `cu8` format, with exact byte geometry and a 64 MiB contract ceiling. The I/Q route is rendered only for a source that advertises that capability; it does not imply SDR hardware support. A future Neptune or other hardware integration requires a distinct source identity, truthful device/scaling/provenance declarations, a driver, bounded sample-transfer behavior, and acceptance evidence. Chunking, streaming, backpressure, cancellation, and overrun behavior require a new contract before continuous acquisition is exposed.

### 2.3.1 Firmware installation ownership

Atomizer application contract 6 has no firmware-update dialog, top-bar update
affordance, updater IPC, or Atom updater tool. Installed firmware identity and
custom-unqualified provenance remain visible as device evidence. OEM release
selection, manifested custom-firmware admission, download/import verification,
preflight, DFU discovery, flashing, journaling, and recovery belong exclusively
to standalone sibling `../Atom-Flasher`. Its active interface catalog v3
retains active application contract v2 (`deviceContractVersion: 2`); interface
catalog v2 and legacy application contract v1 are frozen. Atomizer neither
launches nor remotely operates that safety boundary.

In a sibling development checkout, Flasher's native custom-manifest picker
starts in `../Atom-Firmware` when present and remembers another directory only
after one of its selected manifests passes admission. This is picker convenience,
not a visible Atomizer control, artifact attestation, or runtime coupling.

### 2.4 Active-function control surface

Instrument settings use one shared `ParameterRow` contract across analyzer,
marker, trace, display, detector, classifier, generator, waterfall, and channel
surfaces:

1. A closed row exposes one label and one complete effective value at a minimum
   44 px target height; main-app rows use 52 px.
2. Numeric or free-form values do not render as permanently small input boxes.
   Activating the full row opens one document-level, no-scroll numeric-entry
   popover beside the originating row. It is portaled outside transformed
   inspectors, chooses the available left/right viewport edge, and never dims
   or displaces the measurement canvas. It exposes a large selected field,
   touch-sized decimal keypad, bounds, and explicit Apply/Cancel actions. Focus
   stays inside the panel and returns to the originating row on commit, Cancel,
   outside-click dismissal, or Escape.
3. Frequency entry is stored and validated as integer Hz. The panel selects a
   readable current scale and exposes `GHz`, `MHz`, `kHz`, and `Hz` unit
   terminators. Choosing a terminator converts, validates, commits once, and
   closes; Enter in the entry field commits with the selected unit. Unitless
   settings use an explicit Enter terminator. Button keyboard activation keeps
   its native meaning and cannot accidentally invoke the field's Enter path.
4. Blank, non-finite, below-minimum, above-maximum, parse, schema, and domain
   errors remain inside the open row. They never mutate application or device
   state and are never replaced by a guessed value.
5. Opening another value in the same parameter stack closes the previous
   editor. A stack cannot become a spreadsheet of simultaneously open fields.
6. Enumerated values make the whole row the selection target and always render
   the current human label before activation. A current value without a closed
   option is a programming error and fails loudly.
7. Boolean rows expose both text (`On`/`Off`) and state treatment. Color alone
   is insufficient.
8. Settings are one value per row. `Advanced` may create one additional group;
   deeper settings trees and side-by-side editable values are forbidden.
9. Escape closes transient measurement drawers. Changing measurement view also
   closes them; neither action changes configuration or acquisition state.
10. Every row carries a stable agent-control identifier where the capability is
   agent-operable. Visual, semantic-computer, and typed Atom operations converge
   on the same validated application reducer. Every portaled keypad carries the
   originating control identity as `data-parameter-editor`; while open, the one
   stable agent-control hook moves to the portal and the occluded source row is
   explicitly excluded. No transient input becomes an unowned or duplicate
   reducer. Atom still prefers the exact typed configuration tool.

The visual system uses neutral graphite hierarchy and macOS system typography.
System blue means selection/action, violet identifies Atom, amber/red retain
caution and hazard semantics, and plot palettes remain free to encode RF data.
Measured-data color must not tint general window chrome.

Acceptance:

- `UI-PAR-001`: current values remain readable with every editor closed.
- `UI-PAR-002`: click, keyboard activation, Enter, and Apply follow one commit contract.
- `UI-PAR-003`: invalid entry remains open with a specific inline error.
- `UI-PAR-004`: only one editor per stack can be open.
- `UI-PAR-005`: disabled rows cannot open and are visually consistent.
- `UI-PAR-006`: all Atomizer route value controls are shared rows; raw route-local numeric/select controls are absent.
- `UI-PAR-007`: reference screenshots show no truncated effective value, second-line chevron, horizontal overflow, or body scroll.
- `UI-PAR-008`: `915` followed by the `MHz` terminator commits exactly `915000000` Hz once; invalid bounds/steps remain open and uncommitted.
- `UI-PAR-009`: numeric-panel focus is trapped and restored; Escape and Cancel do not mutate configuration.
- `UI-PAR-010`: the numeric editor is a body-level anchored portal and is never clipped or positioned by a measurement inspector.

The unit-terminator interaction follows established X-Series active-function behavior without copying vendor visual trade dress. Primary references: Keysight X-Series User's and Programmer's Guide, https://www.keysight.com/mg/en/assets/9018-04190/user-manuals/9018-04190.pdf, and Keysight X-Series Getting Started Guide, https://www.keysight.com/my/en/assets/9018-01478/quick-start-guides/9018-01478.pdf.

## 3. Global state contracts

### 3.1 Connection state

```text
disconnected -> discovering -> matching preference -> connecting -> admitting -> ready
      ^                                                                  |
      +---------------------------- faulted <-----------------------------+
```

| State | UI obligation | Allowed actions | Forbidden claims |
|---|---|---|---|
| Disconnected | “No instrument”; show connect action | Refresh, select, connect, inspect saved sessions | Current source state or verified settings |
| Discovering | Bounded progress plus per-driver outcomes | Cancel | Treating one driver failure as an empty global discovery |
| Matching preference | Show the persisted exact tuple, a legacy broad intent, or exact `signal-lab:default` factory choice | Inspect candidates; choose explicitly if startup cannot match | Choosing a different available source as fallback |
| Selecting | List candidates by driver, source kind, name, and truthful identity summary | Refresh, choose, connect, cancel | Treating USB VID/PID, synthetic status, or twin presence as interchangeable proof |
| Connecting | Disable duplicate connect; show chosen source | Cancel if the driver supports it | “Ready” |
| Admitting | Show source-specific protocol and evidence validation | Disconnect/cancel | Capabilities or provenance until resolved |
| Ready | Show driver/source, qualification, capabilities, and device/firmware only when applicable | Only capability-declared operations | Verification not supplied by the source |
| Faulted | Preserve typed cause and recovery action | Retry, disconnect, diagnostics | Generic “something went wrong” alone |

### 3.2 Acquisition state

```text
idle -> configuring -> acquiring -> complete
  ^          |             |           |
  +----------+-------------+-----------+
             +-----------> failed
```

- Only one acquisition operation owns the UI at a time.
- `configuring` and `acquiring` have distinct labels.
- Previous data remains visible during acquisition but is marked stale until the new sweep completes.
- Failure preserves the previous valid sweep and attaches the error to the failed operation.
- Continuous acquisition is not a loop in the renderer. It is a bounded service stream with dropped/coalesced-frame accounting.

### 3.3 Generator state

Actual output is represented by `off | on | unknown`; `unknown` is not styled as a neutral idle state.

| Event | Result |
|---|---|
| Application starts | `off` as host intent; no claim about an unrelated already-running device |
| Connection completes | Command and verify off where possible; otherwise `unknown` |
| Generator configured | Output remains off |
| Enable succeeds | `on`/`commanded`, or `on`/`verified` if readback exists |
| Disable succeeds | `off`/corresponding verification |
| Cable lost while on | Immediately `unknown` |
| Reconnect | Never restore prior on state |
| Leave Generator while on | Block navigation and require disable |
| Clean application quit | Best-effort off; log result |

SignalLab Studio is not part of this RF-output state machine. Switching a
SignalLab profile or replay channel cannot enable RF output and never creates an
`on` or `unknown` generator state.

### 3.4 Complex-I/Q capture state

```text
idle -> configuring -> acquiring -> complete
  ^          |             |           |
  +----------+-------------+-----------+
             +-----------> failed
```

- The route exists only while the active session advertises `complex-iq`.
- Configuration is reconciled to the driver's center, rate, bandwidth, count,
  format, and optional bandwidth-coupling constraints before admission.
- One operation returns one complete buffer. Continuous mode, partial buffers,
  and renderer-owned capture loops are forbidden in v1.
- The renderer validates the measurement session/revision, format-dependent
  byte geometry, and finite preview samples before replacing the last capture.
- The evidence footer preserves the measurement's exact qualification. A
  SignalLab laboratory buffer reads `analytic-complex-baseband`; a
  standards-labelled buffer reads `standards-derived-complex-baseband`. Neither
  is relabeled as a scalar visual projection or conformance vector.
- Plotting is bounded to 16,384 evenly sampled preview points; full-payload
  retention and transport remain governed by the measurement contract.
- The constellation is Q versus I only and makes no symbol-decision,
  modulation, EVM, protocol, calibration, or conformance claim.
- SignalLab advertises independent bandwidth from 1 kHz through the requested
  sample rate and admits all 34 closed profile IDs. Its causal
  one-pole complex-baseband response has two-sided steady-state -3 dB edges at
  `±bandwidthHz / 2`; I and Q use the same real coefficient, the first output is
  initialized from the first analytic sample, and the replay channel is not
  applied to the v1 buffer. Standards-labelled buffers are deterministic
  engineering projections, not packet-decodable I/Q or conformance vectors;
  framework-generated independently validated assets remain future work.
- I/Q controls are capability-gated UI operations; they are not Atom tools until
  separately admitted by the AI-native contract.

## 4. Connection workflow contract

### UX-CONNECT-01 — Select and connect

**Trigger:** connection pill, connection banner, or first-run action.

**Inputs:** versioned `InstrumentCandidate[]`, driver-scoped discovery failures, and the active owner-only exact candidate preference or readable legacy v1 broad record.

**Output:** validated `InstrumentSessionSnapshot` or typed failure.

**States:** loading, no candidates, partial discovery, candidate list, matching preference, connecting, connected, failed.

Rules:

- New preference writes contain `{driverId,candidateKind,candidateId}`. Startup connects only that exact candidate; stale exact IDs fail closed. A legacy v1 broad record may connect only one unique match and fails on ambiguity. Only an absent preference file selects exact `signal-lab:default`; startup never substitutes another driver, source kind, or candidate.
- Manual selection and “make default” are explicit and separate; selecting a source for one session must not silently rewrite preference.
- Each option shows driver, source kind, human label, qualification and only identity fields truthful for that candidate. SignalLab never shows USB/firmware fields; the twin never shows verified USB; a serial candidate may show admitted serial/USB evidence.
- Refresh retains a manual selection only when the same driver/source-kind/candidate identity remains in the new discovery revision; stale candidates cannot connect.
- Connecting disables refresh, candidate changes, and duplicate submissions.
- On success, focus returns to the triggering control and the dialog closes.
- On failure, the dialog remains open and distinguishes driver unavailability, bridge identity/protocol, permission, busy-port, unsupported firmware/device, timeout, ambiguity, or source-specific transport causes.

## 5. Spectrum workspace contract

### UX-SPC-01 — Configure range

Inputs are start/stop or center/span in integer Hz and capability limits. Stop must exceed start. Editing one representation updates the other only after a valid commit. Invalid text remains editable with an inline message and never reaches IPC. Quick ranges are named presets with inspectable values.

### UX-SPC-02 — Configure sweep

Inputs include points, resolution bandwidth, attenuation, detector, trigger mode/level, spur handling, harmonic avoidance, and LNA state. “Automatic” is a typed value, not `0` or an empty string. Unsupported options are absent with an inspectable reason, not merely disabled without explanation. Simultaneous traces and markers are host measurement controls, visibly separated from firmware-verified analyzer settings.

### UX-SPC-03 — Acquire once

1. Validate locally.
2. Send typed analyzer configuration.
3. Show `configuring`.
4. On success, request one sweep and show `acquiring`.
5. Atomically replace the trace when arrays and provenance validate.
6. Update peak, noise floor, detections, range, age and verification state together.

An incomplete or mismatched sweep never partially paints.

### UX-SPC-04 — Plot interaction

- `SpectrumPlot` is a live React visualization. Every admitted sweep, trace,
  marker, display, and Detect-overlay state change recomputes the current DOM
  geometry. SVG is only the bounded drawing primitive for those current values;
  it is not a static image, exported plot, or substitute measurement store.
- X axis is actual frequency; Y axis is power in the selected unit.
- Axis endpoints and units are always visible.
- Zoom/pan never changes device configuration until an explicit “acquire this range” action.
- Markers are keyboard reachable and expose frequency/power text.
- A stale trace remains visible with a stale badge.
- Simulated data carries a persistent environment badge and export provenance.
- At reference throughput, pointer/keyboard interactions target p95 latency below 100 ms.

### UX-SPC-05 — Traces, markers, and amplitude display

The compact measurement command bar exposes four host traces, eight markers, and
reference-level/division controls without reducing the plot to a secondary
surface. Exactly one panel opens at a time. Trace modes are Clear/Write, Max
Hold, Min Hold, linear-power Average, View/Freeze, and operator-facing Off
(`blank` on the internal contract). Markers are
trace-assignable and support fixed/peak tracking, peak/min/next search, normal,
delta, and noise-density readouts. All eight markers are off by default; the
exact untouched legacy M1-on preference migrates to all-off without rewriting a
deliberately edited bank. Host traces render as `H1..H4`. Enabled firmware trace
readbacks are listed independently as `D1..D4`; overlays are off by default and
require an explicit per-trace visibility action. Visible device traces retain
distinct dash/color treatment and `firmware-readback` evidence. Exact
calculations, persistence, reset, and failure semantics are governed by
`MEASUREMENT_CONTROLS_CONTRACT.md`.

An enabled marker exposes a signal-aware local card with observed 3 dB response
status, separately labeled 99% robust-floor-subtracted threshold-component OBW,
peak-to-robust-floor, prominence, and any bounded current detector-row
context. The card occupies a dedicated grid row outside the SVG plot canvas; it
never floats over a signal. A fixed-pixel HTML overlay places the M tag directly
above a diamond and raises both above the live trace; the SVG retains only the
marker stem and, when both half-power crossings exist, an unfilled edge bracket.
Missing or truncated crossings display dashes and a reason. The UI never labels the scalar
context calibrated SNR and never substitutes 99% OBW or aggregate Bluetooth
frequency support for local marker width.

Peak placement keeps a CW-like or resolution-limited narrow response on its
actual sampled maximum. A bounded broad component instead uses the nearest
measured bin to its noise-subtracted linear-power centroid. That center and the
component-local 99% OBW do not use contiguous 3 dB width as a surrogate. A
qualified component retains its OBW through missing, truncated, or nonmonotone
crossings, while a bounded broad component retains its centroid when disjoint
half-power islands make 3 dB width nonmonotone. Missing/truncated crossings do
not manufacture a centroid for an unbounded response.

Analyzer rows emit atomic patches that merge against the latest staged state,
never a sidebar-render snapshot. Run applies that exact staged revision. While
Run is active, a committed change stops after the in-flight sweep, shows
`RETUNING`, applies and verifies the newest merged revision, then restarts
continuous acquisition. Any in-flight sweep carrying a superseded requested
configuration is quarantined and cannot repaint the new span. Failure leaves
the new staged value visible, stops the run when it was already stopped, and
reports the exact cause; it never leaves the old device setting silently active.

Run, Single, and Stop occupy one persistent sidebar acquisition rail rather than
a Spectrum header or route-local command row. The rail preserves the exact
swept-spectrum transaction and retune semantics above, exposes its state on
every workspace, remains keyboard-operable with native buttons, and disables a
new acquisition when the active source cannot truthfully or safely admit it.
CSV/JSON export remains a contextual latest-sweep utility and is never mixed
into the global acquisition rail.

Host/device trace arrays that are mismatched, nonfinite, nonincreasing, or
physically degenerate are also quarantined before reducers or render projection;
they cannot produce marker state, invalid SVG geometry, or a renderer crash.

### UX-SPC-06 — Advanced measurement views

Spectrum, Waterfall, and Channel are first-class sidebar destinations that select
one view inside a fixed-height measurement stage. There is no second internal
view-tab bar. Sweep setup and trace/marker/display controls remain overlays; they
never create document scroll or permanently reduce the active canvas. Waterfall
uses only identical sweep grids. Channel Power, PSD, ACP/ACLR, and OBW are
RBW-normalized host estimates from complete scalar sweeps. Detected-envelope
STFT remains a typed analysis/Agent capability but has no first-class renderer
surface. Exact math, failure behavior, Atom hooks, and acceptance are governed
by `ADVANCED_MEASUREMENTS_CONTRACT.md`.

When the analyzer span changes, an already valid channel definition is retained.
An out-of-span definition is recentered, and only if necessary proportionally
bounded to keep main/adjacent integration windows inside the new span.

## 6. Detect workspace — signal-detection contract

Detect is a fixed-height composition (pipeline, spectrum/detection overlay,
result/current evidence, detector controls, and a compact detected-power status
strip). The status strip never scrolls and contains no waveform plot or receiver
editor; target tuning and Bayesian capture geometry are staged automatically.
Only bounded evidence/control regions may scroll, never the document, and the
empty/result state remains visible with Atom open.

Detection consumes immutable sweeps and emits immutable `DetectedSignal[]`. It cannot access serial, IPC, files, React, or generator operations.

Required configuration:

```ts
type DetectionThreshold =
  | { strategy: 'absolute'; levelDbm: number }
  | { strategy: 'noise-relative'; marginDb: number };

interface SignalDetectionConfig {
  threshold: DetectionThreshold;
  minimumBandwidthHz: number;
  minimumProminenceDb: number;
  minimumConsecutiveSweeps: number;
  releaseAfterMissedSweeps: number;
}
```

Required result fields: stable event ID, start/stop/peak frequencies, peak
power, measured local prominence, effective local prominence threshold,
estimated bandwidth, first/last timestamps, source sweep IDs, detector and
tracker versions/configuration, Bayesian prior/posterior and log Bayes factor,
effective target/reference cells, assumed noise shape, observed and target
posterior-predictive null tail, accumulated looks, and quality flags.

### UX-DET-01 — Configure detector

- Adaptive threshold displays estimated floor and margin separately.
- Absolute threshold displays dBm.
- Minimum prominence, minimum bandwidth, and persistence declare exact units.
- Changes affect subsequent analysis; re-analysis of existing data is explicit and records the new config.

### UX-DET-02 — Display detections

- Spectrum never overlays detection bands or dashed peak lines; localization belongs to Detect while Spectrum retains only the compact tracked-count metric.
- Detect renders each promoted, current physical emission as one translucent `startHz..stopHz` bandwidth region plus one dashed line at the region midpoint `(startHz + stopHz) / 2`. It does not reuse `peakHz` as the channel-center line, and it never draws candidate, retained-miss, released, or frequency-agile summary rows as physical annotations.
- Its Evidence surface separates current promoted physical rows, current qualifying candidates, and current frequency-agile activity summaries. Retained-miss and released rows never read as current signals. Ordinary selectable targets are current promoted physical representatives. For one current promotion-qualified agile opportunity, the operator or Atom selects the synthetic activity evidence representative, which maps to its uniquely bound latest raw physical tune owner; the raw candidate ID is not independently selectable and the synthetic summary never owns the physical tune.
- Auto evaluates the complete exact sweep currently drawn, admits only eligible physical target projections whose latest sweep ID, capture timestamp, bounds, and peak belong to that sweep, and selects the row with greatest current-source-sweep integrated excess power. Rank evidence integrates positive linear power above the robust lower-tail floor over complete physical cells and normalizes by actual RBW. Stale, retained-miss, released, off-span, and synthetic summary rows are excluded; stable evidence key and raw ID break exact-power ties. An explicit current selection remains explicit until the operator resumes Auto or that row ceases to satisfy the same visible-sweep contract.
- Detected-power capture retains that exact selected projection. If its evidence representative does not yet have an exact runtime-admitted eight-sweep window, capture fails visibly; it never substitutes a weaker runtime-ready row while leaving Auto selected.
- Active and qualifying physical rows provide peak frequency, power, measured/required prominence, detector posterior with its exact scope, detector identity, bandwidth, persistence, and missed-look count. Agile summaries instead expose their conditional dynamics posterior, local posterior, admitted opportunity counts, recency, and non-emitter-identity qualification.
- Selected event synchronizes plot highlight, detail panel, and classification candidate.
- Zero events is a valid outcome, distinct from “not analyzed” and “analysis failed.”

### UX-DET-03 — Track across sweeps

`SignalDetector` with `bayesian-exponential-multiscale-cfar-v3` first applies
the declared absolute/adaptive segmentation threshold and bridges only bounded
gaps of at most two returned sweep bins. At each segment peak it evaluates the
members of a predefined narrow-to-wide region family. The multiplicity count
includes every possible raw-bin center and every acquisition-derived scale, so
data-dependent segmentation cannot reduce the correction. In linear power,
each test integrates the unknown local-noise rate from untrimmed outside
references and compares the null with a declared positive-power-gain mixture.
Until physical calibration exists, the model fixes the noise shape to the
heavier-tailed single-look exponential baseline and limits effective target and
reference counts by RBW. A candidate must clear the prominence rules,
posterior signal probability 0.99 under prior 0.01, and predictive tail
`0.001 / (raw points × tested scales)`.

The 0.001 value is an ideal-model familywise per-sweep target by a Bonferroni
union bound; it is not an achieved tinySA false-alarm rate. Detector/log
response, marginal noise law, RBW correlation, nonstationarity, overload, and
reference contamination require configuration-matched physical calibration.
Ideal-Gamma Monte Carlo remains an implementation stress test. It already
falsified the prior candidate-local shape estimator, which was removed rather
than presented as calibrated evidence.

The stationary-null regression uses the exact declared permissive high-
candidate-load segmentation path. A lower threshold can merge components, so
that path is not labeled a mathematical superset of production segmentation.
The last published run observed zero detections in 64,000 stationary-null
sweeps; the Bonferroni simultaneous-family 95% upper Wilson bound was
0.000933724 against the 0.001 target. Across 56,000 one-look analytic-
alternative trials, the worst pointwise 95% lower bounds at 15/20/25/30 dB were
0.387301/0.693591/0.848580/0.939026, above their declared gates. Those trials
measure a production-settings sweep-local candidate whose threshold-connected
component contains the declared center before tracker promotion.

A separate matrix passes two ordered independent analytic looks through the
exact production detector and runtime tracker, then requires an active track
containing the declared center. Its pointwise lower gates at 15/20/25/30 dB are
0.0225/0.36/0.5625/0.81, the squares of the independent-look one-sweep gates.
Neither Pd matrix carries simultaneous-family confidence, and both are
conditional on the fixed 0.01 detector prior, 0.99 posterior gate, and declared
18 dB-scale truncated positive-power-gain mixture. Paired monotonicity
violations in the last published one-look run and topology mismatches in 2,000
common-scale checks were both zero. The UI may describe these only as ideal-
model development validation: the separate gain-step, impulse, and heavy-tail
susceptibility diagnostics explicitly show why they are not physical tinySA
calibration, prior-sensitivity evidence, or a prevalence claim.

Tracking is a separate stateful stage from sweep-local segmentation. The
`bayesian-two-state-track-filter-v1` model predicts each prior from explicit
appearance/persistence probabilities and updates it with the current candidate
Bayes factor, rather than blindly multiplying correlated sweep evidence.
On a missed sweep it exposes only the transition-predicted
`track-predictive-state`; it does not present a posterior conditioned on an
invented miss likelihood.
Association remains a one-to-one best match by occupied-range overlap and
bounded peak-frequency distance. It promotes a stable ID after
`minimumConsecutiveSweeps`, records missed sweeps, emits one explicit `released`
result after the miss window, and then removes the track. Only active tracks
enter classification. Configuration changes reset the tracker rather than
rewriting prior provenance.

Before claiming production detection quality, publish posterior-predictive
goodness of fit, event-level precision/recall, achieved false alarms per
cell/sweep/hour, detection probability versus SNR, frequency/bandwidth error,
performance by physical acquisition configuration, and boundary/overlap and
reference-contamination behavior.

## 7. Detect workspace — waveform-classification contract

Classification comprises four explicitly separated evidence levels:

1. **Spectral morphology:** deterministic labels for narrow carrier, multi-carrier, wideband noise-like, and band-limited trace shape. Implemented as experimental evidence; it is not a modulation or protocol claim.
2. **Zero-span envelope:** deterministic steady, amplitude-varying, or pulsed detected-power behavior. Implemented; zero span is not I/Q.
3. **Bayesian observable equivalence:** the content-addressed
   `bayesian-observable-equivalence-v8` model compares 28 available
   scalar-spectrum, history, and optional qualified detected-envelope features
   with 11 known evidence leaves plus a fitted unknown leaf. Its regularized
   empirical Student-t components are fixed plug-in likelihoods, not
   posterior-predictive parameter integration. An unavailable envelope selects
   `spectrum-only`; a qualified envelope without fully qualified cadence selects
   `envelope-untimed`; and fully qualified timing selects `envelope-timed`.
   Every selected view supplies its exact complete fitted dimension set; the
   runtime neither marginalizes an arbitrary subset nor imputes a missing
   feature. Detector-conditioned, generator-separated
   `spectrum-only`, `envelope-untimed`, and `envelope-timed` calibration sets
   supply empirical class-conditional synthetic support ranks. Calibration v19
   uses one score per observation-domain-eligible independent branch attempt:
   the consecutive-spectrum score is the minimum across all fit-eligible
   runtime representatives in the complete 32- or 96-look horizon, while each
   qualified-envelope view uses its sole fit-eligible rank-0-integrated-excess capture.
   Exact score counts come from the generated training matrix and are
   independently reconciled by validation. Inference
   uses the matching view. The fixed, stratified synthetic reference grids are
   not exchangeable operational samples, so the 0.025 engineering rejection
   cutoff is not a conformal p-value threshold and has no finite-sample coverage
   meaning. A support rejection presents primary label `unknown`, zero
   confidence, and its `synthetic-support-rank` value and cutoff; ranked
   model-posterior candidates remain diagnostic. The decision is the finest
   defensible leaf or ancestor, including deliberate LTE/NR cellular-OFDM
   ambiguity; active SignalLab selection is never an input. Implemented as
   experimental synthetic-domain evidence, not protocol identity or physical
   calibration. Its preprocessing, calibration, and decision provenance are
   `scalar-observable-features-v7`,
   `synthetic-independent-branch-view-matched-causal-acquisition-support-rank-detector-conditioned-physical-uncalibrated-v19`,
   `observation-only-hypothesis-domain-v5`, and
   `observable-open-set-decision-v10`, with prior
   `engineering-design-class-weights-v1`. The 35-scenario, 18-unknown
   `observable-scalar-corpus-v13` corpus is pinned at commit
   `03bc13eb9d5efcfc5f2f9c1792042f670b71ef9a`. Its canonical JSON source
   manifest covers `package.json`, `package-lock.json`, and the complete
   six-file TypeScript import closure rooted at `src/classification-corpus.ts`,
   including `src/canonical-timing.ts`, and has
   SHA-256
   `38288f0e0437dbb687674308afecb4f30adadc9e93ea7abad3b8bf13d80ec918`,
   and requires a clean SignalLab tree plus every regular, non-symlink, tracked
   artifact to byte-match its blob at that commit.
   The checked-in v8 likelihood architecture has 28 ordered feature dimensions and 12 exact leaf class IDs. Its spectrum-only population has 18 source scenarios and 28 likelihood components; each envelope population has 16 scenarios and 26 components because the Bluetooth-like class is structurally unsupported for fixed-tune envelope evidence. Under scenario-components-with-three-shared-covariance-csma-activity-modes-v1, exactly five pinned CSMA sources use three deterministic activity modes while every other supported source/view pair uses one component; source scenarios retain equal within-class mass, CSMA modes use empirical within-source weights, and each decomposed source shares one pooled within-mode covariance. Under frequency-agile-fixed-tune-envelope-censoring-v1, the analysis boundary validates the physical capture and schema-4 receipt first, including its canonical SHA-256 binding of all returned samples, cadence, requested geometry, RF metadata, and provenance, then excludes detected-power envelope features for every frequency-agile association and classifies its exact regional spectrum/history view. This censor is triggered by observed association geometry, never a truth label or requested hypothesis; Bluetooth envelope component and calibration arrays are therefore exactly empty. The independently regenerated v19 asset has SHA-256
   `6e25efced19690b599745000fe6b0ea46ca1af67220bb3b2b3b691b9bcf2ffe4`.
   Production inference does not use missing-dimension marginalization: v8 selects one exact evidence view, requires its complete finite feature set with no extras, and evaluates only the independently fitted spectrum-only, envelope-untimed, or envelope-timed likelihood population.
   Domain policy v5 permits an FM leaf only with resolved sidebands
   (`spectrum.sidebandScore >= 0.2`) or a materially modulated envelope
   (`envelope.rangeDb >= 2` and `envelope.standardDeviationDb >= 0.5`). The UI
   must leave an unresolved finite FM view CW-like or `unknown` and describe
   this as an evidence-resolution limit, not a universal FM rule.
   The open-set rejection cutoff is a minimum maximum-known synthetic support rank of 0.025; it is an engineering threshold, not a p-value or coverage guarantee.
   The completed v19 release evidence satisfies the acquisition contract below.
   The fitted and independently regenerated acquisition matrix uses SignalLab's 450-point recommended-span grid in two independent production-gate sessions under independent-no-auto-spectrum-and-qualified-rank-0-integrated-excess-envelope-sessions-v2. The no-automatic-capture consecutive-spectrum branch starts its twelve profiles at source looks 0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, and 416 and spans source indices [0, 512); the qualified-envelope branch starts them at source looks 0, 33, 66, 99, 132, 165, 198, 231, 264, 297, 330, and 427 and spans [0, 524), with at most one detected-power capture after rank-0 runtime admission. Under preferred-then-current-source-sweep-integrated-excess-power-physical-or-qualified-agile-member-target-v4, ordinary targets are active physical rows with zero missed sweeps. The only candidate-state exception is the exact latest raw detector/track member cited by the latest exactly-one opportunity of a current, promotion-qualified, zero-miss frequency-agile association. The synthetic activity summary never owns the hardware capture, and arbitrary candidates, stale members, retained summaries, and ambiguous opportunities remain ineligible. An autonomous branch ranks eligible raw rows by current-source-sweep integrated excess power under current-source-sweep-integrated-excess-power-v1; it integrates positive linear power above the robust floor over complete physical cells and normalizes by actual RBW. The stable representative key and raw ID are exact-power tie-breaks. Association qualification controls only whether the narrow agile projection exists, never priority among eligible rows. Truth labels, class-domain eligibility, feature readiness, and classifier posteriors never influence that ranking. After ranking, the controller tunes and binds the capture to the raw row while receipt schema 4 projects the exact eight-sweep classifier window to its evidence representative and binds the complete returned capture with domain-separated canonical SHA-256. For an agile projection the receiver remains fixed on the selected physical channel and may observe later returns or no return; it never follows the hop and proves neither a common emitter nor Bluetooth protocol or mode identity. Under frequency-agile-fixed-tune-envelope-censoring-v1 the valid capture and receipt remain audited, but every frequency-agile fixed-tune envelope is excluded from classifier features and the exact regional spectrum/history view is used; this observation-geometry censor is independent of truth or requested hypothesis. Later spectra continue at the next source look. Held-out validation begins at source look 512 for consecutive spectrum and 524 for qualified envelope. Every envelope admitted to a classifier likelihood requires an analysis-issued capture receipt and is explicitly qualified as receipt-verified-provenance-bound-runtime-admitted-physical-capture-v5; receipt-free or runtime-unadmitted captures cannot enter Bayesian envelope metrics. Public detected-power synthesis uses the generator-internal 100 kHz filter; measured detected-power RBW remains unavailable and is never classifier evidence.

   The schema-4 receipt is minted only by the analysis boundary after independent replay and candidate ranking, is deeply frozen and process-authorized, and is revalidated against the representative, admitted tune, ordered eight-sweep window, and domain-separated SHA-256 of the complete canonical returned capture before envelope features are admitted. It binds every power sample, cadence and requested-geometry/control field, RF metadata/qualification, source field, and provenance field, so a receipt cannot qualify a substituted finite capture. Issuance rejects root or nested Proxy graphs and retains a deeply frozen structured-clone snapshot; feature extraction consumes only that authority-owned snapshot after verification, eliminating hash/read TOCTOU.
   The App zero-span action enters a Bayesian envelope view only when the capture is bound to an analysis-issued receipt for a current runtime-admitted target, exact admitted tune, and exact eight-sweep evidence window. Receipt qualification is necessary but not sufficient: under frequency-agile-fixed-tune-envelope-censoring-v1, every fixed-tune frequency-agile capture remains excluded from Bayesian envelope inference and the exact spectrum view is used instead. Any other receipt-free or runtime-unadmitted capture may feed only the separate envelope heuristic.
   Its two Wi-Fi leaf posteriors remain diagnostic; the primary Wi-Fi label is
   only `802.11-compatible channel morphology · PHY unresolved`, never an
   802.11 protocol or PHY identity.
   An association retained for operator continuity by tracker hysteresis stays
   visible, but if its current evidence is below the classifier promotion gate
   it presents insufficient evidence and is not an observation-domain-eligible calibration
   window.
   Tracker readiness alone is not classifier admission. “First-ready” is the
   earliest online opportunity whose complete cited sweeps replay as one
   coherent, uniquely matched scalar evidence window. Runtime-unavailable
   evidence is shown as `unknown` / `insufficient-evidence`; only a declared
   retryable replay/ROI case may admit a later valid window during deterministic
   sampling. Missing required provenance, duplicates, and contradictions remain
   hard validation failures.
   Cellular structural eligibility comes from
   `standards-operating-band-context-v1`, pinned to TS 45.005 19.0.0,
   TS 36.101 18.5.0, and TS 38.104 18.12.0. It tests complete observed-interval
   containment with a bounded RBW edge tolerance and preserves every compatible
   FDD, TDD, SDL, or SUL row in an overlap. It is a model-support mask, not
   protocol, deployment, survey-prior, or regulatory-authorization evidence;
   SDL/SUL alone cannot create an FDD/TDD result.
   The broad cellular masks and 5/6 GHz Wi-Fi masks are standards-context
   extrapolations beyond the fitted Band 3/Band 38/n3/n78 and 2.4 GHz centers,
   not empirical fitting or physical validation throughout those bands.
   `engineering-design-class-weights-v1` is likewise an engineering assumption,
   not field prevalence; deterministic sensitivity gates do not replace
   representative physical survey calibration.
4. **Validated modulation/protocol classifier:** physical taxonomy, labeled corpus, training pipeline, calibrated model, evaluation and supported-domain statement. Hardware/data gated and not claimed by the Bayesian observable model.

### UX-CLS-01 — Pipeline visibility

Capture, promote, extract-observables, capture-envelope, and Bayesian-decision
stages are independently `waiting | ready | running | complete | failed |
unavailable`. A future physically calibrated model being absent does not
invalidate deterministic morphology/envelope or synthetic observable-class
evidence and never permits a stronger label.

### UX-CLS-02 — Candidate selection

Each candidate shows its source detection, frequency, bandwidth, power, time window and capture sufficiency. Selecting a candidate never mutates analyzer or generator state.

The detector freezes the classification region and records its originating
sweep ID at first admission. Classification does not recenter that region as a
tracked peak moves; the tracker appends only independently re-detected sweep IDs
to the event. Feature extraction accepts only coherent sweeps bound to that
event and matching acquisition, device, firmware, and execution provenance.
The provisional 2.4 GHz frequency-agile association stores its bounded band and
source sweeps separately, together with
`frequency-agile-2g4-activity-v3` association provenance and
`bayesian-frequency-agile-transition-v3` dynamics provenance. It never
overwrites the frozen emission region, and the UI must distinguish
association-band activity from emission localization.
Matching zero span is additionally bound to the target detection. All admitted
source sweeps in the fixed most-recent eight-admission window contribute inside
the applicable provenance region; classification does not apply a second 3 dB
active-bin admission gate or pool arbitrary longer track history.

The tracker is frequency-local by default and also exposes a provisional
`frequency-agile-2g4-activity` association for separated narrow candidates in a
complete 2402--2480 MHz sweep. It retains every strictly ordered opportunity as
none, exactly one independently CFAR-admitted eligible narrow candidate, or
ambiguous. The dynamics model conditions change/no-change evidence only on
positive unambiguous looks, requires at least eight positives over at least
three resolution cells, and bounds the history to 96 opportunities. Transition
model v3 compares an equal mixture of the neutral
`fullBand79CellChangePrior = Beta(78,1)` and
`threePrimaryChannelChangePrior = Beta(2,1)` engineering Beta-Binomial
families with the fixed stationary Bernoulli likelihood `p_change=0.05`.
Neither agile family is a Classic/LE protocol or emitter likelihood. Its exact
sequential false-promotion upper bound is `1.3657385209e-5` through 96 positive
looks under that independent stationary null, before the additional three-cell guard. The
UI must not present this model-bound calculation as a physical or merged-emitter
false-association rate. This is broad band-activity evidence, not
transmitter/link identity, a recovered hop
sequence, or an advertising triplet; it can merge unrelated emitters or leave
real activity fragmented.
Fixed-frequency zero span also cannot observe a link-wide Classic slot sequence
or a three-channel LE advertising event, so any link-wide synthetic cadence is
not a valid Classic/LE discriminator. SignalLab's frequency-conditioned
channel-local envelope remains display and acquisition-audit evidence, but v19
excludes it from every classifier likelihood. The UI must
present the association as provisional spectrum/history evidence, retain the
Bluetooth-like and synthetic/uncalibrated qualifications, and keep weak or
ambiguous evidence
at Bluetooth-like band activity or `unknown`.

Trainer, tail-calibration, and held-out-validation standard scenarios offer 32
sequential 50 ms opportunities; full-band 2.4 GHz scenarios offer 96. The
modeled 20 ms BLE advertising interval and
`ble-primary-advertising-engineering-v1` schedule—all three 2402/2426/2480 MHz
primary centers in sequential 37-to-38-to-39 order,
`packetStartSpacingSeconds=0.0015`, 376 microsecond packets, and deterministic
seeded per-event `advDelay` in `[0,10 ms)`—are evaluated over that declared
finite horizon. UI copy must say this sequence is standards-consistent for the
modeled legacy all-three-channel event, while configured subsets, early event
closure, and extended advertising differ. The all-three use, spacing, duration,
interval, and deterministic delay generator are SignalLab engineering choices,
not universal Bluetooth traffic or PDU behavior. The 80 MHz field is an
aggregate primary-channel support span, not instantaneous occupied bandwidth.
The UI and reports show admission separately from
conditional classification and do not render a non-admission as a failed class
prediction or negative observation about BLE. The superseded pre-v19 held-out
synthetic run acquired BLE at one or more tested RBWs for 5/8 event-phase seeds
at 24 dB and 8/8 at 32 dB; all 32 admitted BLE representatives returned only
Bluetooth-like band activity. These historical figures are unavailable as
current release evidence until a fresh v19 report replaces them. They are
synthetic acquisition results, not physical BLE sensitivity or identity
validation.

The `regular-spectral-component-activity` association is classification-only.
It requires at least three regular same-sweep components. Every member remains
an independently detected, independently expiring local
track. The association separately records its stable allocated lineage ID,
exact per-look member-track IDs, current hull, spacing, lattice anchor, source
sweeps, miss state, and `regular-spectral-component-lineage-v2` provenance.
Every cited look is independently replayable. Successive looks must share a
compatible lattice, overlapping hull, and at least one resolved component
center; public members and region are always those of the latest look.
Competing overlapping regular hypotheses or an irregular interior component
produce no group. Group expiry
removes only association evidence. Classification requires exactly the latest
eight admitted co-occurrence looks and runs once per association. The result is
mapped to every member row with a visible `Group` qualifier, while the selected
row continues to show local frequency/power/bandwidth provenance plus the
separate association evidence. Neither layout nor copy may imply that the
components share an emitter.

The `multicomponent-swept-region-activity` association is also
classification-only. `multicomponent-swept-region-v2` requires at least four
independently `bayesian-exponential-multiscale-cfar-v3`-admitted local members.
Its visible qualification states whether eligibility came from a selected
multiscale region containing the current observed hull or from the resolved
bounded-raster rule; neither route is labeled as identity evidence. The visible
association region and member list always reflect the latest current hull and
latest current membership, not a cumulative union. Historical looks are capped
at the classifier's latest exact eight and retained only for identical sweep
geometry, padded regional IoU of at least 0.75, and at least one component
center shared within `max(2 × RBW, 5 × bin width)`; incompatible history
disappears. Member lists remain attached to their individual historical looks.
A lineage may reconnect only inside the tracker release window; it is not
classification-qualified while missed, and reacquisition after expiry appears
under a new association ID.
The selected row still shows its independently admitted local detection and
local zero-span tune. The UI must not draw the local zero-span trace as regional
time coverage or imply simultaneity, a common generating process, or emitter
identity.

### UX-CLS-03 — Result

Required presentation:

- Primary label or `unknown`.
- Operator-facing labels describe evidence, for example `CW-like carrier`,
  `DSB full-carrier AM-like`, or `Cellular OFDM · LTE/NR ambiguous`. They never
  call the observed emission a replay or imply decoded protocol identity.
- The qualification reads `BAYESIAN EVIDENCE CLASS · NOT PROTOCOL`. Positive,
  pending, and unknown treatments remain text/icon redundant, so color never
  upgrades the claim.
- A relative score for heuristic morphology/envelope, a fixed synthetic
  empirical-model posterior labeled uncalibrated for Bayesian observable
  equivalence, or calibrated confidence only for a physically validated model.
- Ranked candidates with scores.
- Unknown is retained as a ranked candidate even for a positive result. Unknown
  reasons include low confidence, out of domain, insufficient evidence, model
  unavailable, or inference failure.
- Model ID, corpus source and SHA-256, model-asset SHA-256, preprocessing,
  prior, calibration ID, qualification, score kind, and decision level.
- Evidence link to source sweeps.
- Domain and limitation warnings, including boundary censoring, sweep
  time/frequency skew, missing/mismatched zero span, unqualified cadence,
  frequency-agile band activity, regular-component association, and
  non-identifying multicomponent swept-region association with local-only zero
  span.
- Any timed cadence feature is labeled periodic detected-envelope energy, not
  cyclostationarity or spectral-correlation evidence; wall-clock-derived
  physical timing keeps it unavailable.
- Wireless model-domain eligibility is a hard mask over the measured occupied
  interval, not only its center. UI copy describes an out-of-mask result as
  unsupported by the fitted model, never forbidden by the standard.

### Model package contract

A model package is inert data plus declared inference metadata; it cannot
execute arbitrary scripts. It contains a signed manifest, asset hash, taxonomy,
preprocessing graph ID, prior ID, calibration ID, input shape/ranges, supported
device/firmware/capture domain, validation metrics and license. Installation
validates size, schema, signature policy and hashes in the trusted process. The
built-in observable model is governed separately by
`SIGNALLAB_EMSO_CLASSIFIER_CONTRACT.md` and its pinned corpus/model hashes.

### Classification quality contract

- Dataset splits are grouped by physical capture session and source device to prevent leakage.
- Evaluation includes whole unknown signal families, source devices, and capture
  groups absent from fitting. The current v8 baseline does not satisfy this
  physical requirement. Only `unknown-narrow-fsk` and `unknown-802154` fit the
  unknown likelihood; the strict unknown holdout, ambiguity-only stress cases,
  exact observable-equivalence nulls, and one known acquisition-only GSM case
  remain separate component-fit exclusions. These partitions are reported
  separately and cannot be pooled into a physical open-set claim.
- Report per-class precision, recall, F1, support, confusion matrix, macro metrics, expected calibration error and coverage-risk curve.
- “State of the art” is comparative: record baselines, dataset version, compute budget and evaluation protocol.
- Synthetic nuisance-shift and scenario-excluded scores are reported separately
  from physical validation. The current feature and decision-threshold design
  was developed against that matrix, so it is development regression evidence,
  not untouched validation; it never authorizes calibrated-confidence or
  protocol-identity copy.
- The following figures are from the superseded pre-v19 development regression
  and are unavailable as current release evidence until a fresh, independently
  regenerated v19 report replaces them. That regression used held-out seeds 13001, 13019, 13037,
  13063, 13081, 13099, 13127, and 13151 and interstitial RBW divisors
  15.5/44/98. It covers 4,200 attempts and 9,944 first-ready representatives.
  Hierarchical accuracy is 0.985318, known coverage 0.993796, covered-known
  hierarchical accuracy 1.0, fitted-unknown and strict-holdout rejection 1.0,
  and disallowed false-accept attempts zero. All 840 exact-equivalence cells,
  2,278 representative pairs, and 4,556 evidence-view pairs match within
  `1e-11` with zero discrepancies. UI copy must retain the synthetic
  development-regression qualification alongside these figures.
- Corpus-v13 provenance means the deterministic fixed-slot-0 one-of-eight GSM
  envelope, fully selected LTE TDD configuration, standards-valid NR 7-DL/3-UL
  engineering schedule, and seeded CSMA-like Wi-Fi engineering envelope gate
  each swept bin at its actual visit time. They are scalar acquisition
  schedules, not decoded MAC traffic or protocol likelihoods. UI evidence for
  AM/FM zero span describes a receiver-filtered
  detected-power capture at the recorded tune through the explicit
  generator-internal synthesis filter, not an ideal baseband envelope. The
  production filter is 100 kHz reproducibility provenance; measured
  detected-power RBW remains unavailable. Loaded GSM and fixed-slot-0 GSM are
  distinct scenario names and acquisition claims. The loaded carrier is an
  engineering continuous-occupancy replay with synthetic traffic/control/dummy
  texture, not a decoded GMSK burst sequence or evidence that every GSM carrier
  is continuous. Scenario details must disclose that LTE Band 38 uses
  `lte-tdd-config0-ssp7-normal-cp-downlink-v1`, the downlink-only configuration-0
  `DSUUUDSUUU` schedule with SSP 7
  (714.583333 microseconds DwPTS, 142.708333 microseconds GP, 142.708333
  microseconds UpPTS, exact DL duty 0.3429166667); n78 uses the downlink-only
  engineering 7-DL/3-UL complete-slot schedule over 5 ms at 30 kHz SCS. Its
  exact carrier center is 3,500,010,000 Hz, NREF 633334, on the selected n78
  30 kHz band-specific channel raster, distinct from the 15 kHz global
  NR-ARFCN step in this frequency range. BLE uses the seeded engineering
  schedule above. Copy must say LTE's configuration
  is fully selected and the NR/BLE schedules are scenario-local engineering
  choices, not universal LTE, NR, or BLE behavior. A fractional
  detector centroid is visibly and
  deterministically projected to the nearest advertised integer-Hz tune
  (higher on an exact tie); invalid/out-of-range values fail, and request,
  capture, and classifier provenance retain that one projected value. Selecting
  a classification candidate clears any envelope bound to another candidate
  and stages this tune; it does not acquire until the separate capture action.
- Classifier fitting, support calibration, and regression use the production
  multiscale Bayesian detector and two-state tracker, including the
  frequency-agile, regular-component, and multicomponent swept-region
  classification associations. Fitting, tail calibration, and held-out
  validation offer 32 standard observations; full-band 2.4 GHz scenarios
  offer 96 throughout. Each uses exactly the latest eight admissions.
  Reports separate admission from classification conditional on admission.
  This is end-to-end synthetic-path regression, but it is not described as
  physical detector/classifier performance or emitter identification.
- Learned physical modulation/protocol thresholds remain disabled until corpus
  characterization and session/device-grouped validation are frozen. Heuristic
  morphology/envelope results remain visibly experimental and use relative
  scores.

## 8. Generate workspace contract

### UX-GEN-00 — Select the source-specific surface

A SignalLab profile-selection capability replaces the physical RF-generator
surface with the embedded SignalLab Studio. The Studio renders all six family
tabs from the complete admitted catalog and sends profile/channel intent through
the driver. It shows descriptor qualification, standards sources, and scope
limitations without changing those claims. It contains no enable-output action.
A source with only `rf-generator` capability receives the physical generator
surface below; the two surfaces are never blended.

### UX-GEN-01 — Configure output

Frequency, level, modulation and high-frequency mode are capability-driven. Values are validated by renderer schema and device service safety profile. Applying configuration first commands output off and cannot imply enable.

### UX-GEN-02 — Enable output

- Requires ready connection, generator mode, valid known capability profile and explicit action.
- Copy states “Enable RF output”; a play icon alone is insufficient.
- Duplicate/racing enable requests collapse to one operation.
- Success produces a persistent global RF-on indication.

### UX-GEN-03 — Unknown state

Cable loss, transition timeout or unverified reconnect results in `unknown`. The UI explains that the instrument may still emit and offers reconnection/physical verification guidance. Unknown never decays to off due to elapsed time.

## 9. Component contracts

| Component | Inputs | Outputs | Required states | Test focus |
|---|---|---|---|---|
| `TopBar` | snapshot, environment, Atom state | open connection/Atom | disconnected, ready, simulated, RF global state | identity truncation, keyboard, status text |
| `Sidebar` | route, measurement projection, output state, capabilities | route/view intent | active, unavailable, RF on/unknown | six core destinations, conditional I/Q, guarded navigation, current page |
| `ConnectionDialog` | candidates, selection, busy, error | refresh/select/connect/disconnect/close | empty, list, connecting, connected, failed | focus trap/restore, duplicate submit |
| `SpectrumPlot` | trace frames, markers, detections, busy, freshness, display | marker placement intents | empty, loading, live, stale | exact bins, multi-trace overlay, markers, axes, resize, performance |
| `MeasurementWorkspace` | active visible view, sweep/history, channel config, measurement controls | config/acquisition intents | spectrum, waterfall, channel, overlays | fixed height, no nested tabs, no scroll, view persistence, Atom parity |
| `WaterfallView` | coherent sweep history, color/depth config | validated config intent | empty, populated, grid exclusions | bounded memory, canvas fidelity, scale labels |
| `ChannelAnalysisView` | sweep, channel definition, display scale | validated definition intent | empty, result, out-of-span/error | integration windows, dBm/dBc, OBW evidence |
| `MeasurementDock` | trace/marker/display configurations and readings | configure/search/reset/auto-scale intents | compact, marker, trace, display | calculations, overflow, persistence, keyboard |
| `AnalyzerInspector` | config, capabilities, busy | validated config change | auto/manual, invalid, unsupported | units, ordered range, operation lock |
| `MetricStrip` | sweep, events, operation | none | empty/current/stale | atomic update, units |
| `ClassificationWorkspace` | sweep, detector config/evidence, candidates, pipeline/model/result, compact capture status | config/auto-target/select/capture/classify | not analyzed, zero, qualifying, tracking, no capture, no model, running, unknown, result, failure | synchronized localization/provenance, non-scrolling status strip, and no invented certainty |
| `IqWorkspace` | admitted I/Q capability, configuration, complete capture | configure, capture | unavailable, empty, configuring, acquiring, complete, invalid/failure | capability reconciliation, byte geometry, bounded plotting, no symbol claim |
| `GeneratorWorkspace` | generator config or SignalLab catalog/channel capability | apply/enable/disable or profile/channel intent | physical generator states or embedded Studio states | exclusive source-specific surfaces, safety transitions, human-only Studio controls |
| `DeviceWorkspace` | snapshot, diagnostics, screen frame | refresh/capture/touch/release | disconnected, ready, frame empty/current, failure | pixel framing, coordinates, high-impact guard |
| `StatusBar` | connection, trace, verification, API | diagnostics intent | all global states | always visible and textual |

Components receive domain values and emit intent. They do not call IPC directly except through workspace/controller composition. Formatting and parsing are pure functions with unit tests.

## 10. Custom analysis mode extension contract

Every additional mode supplies:

```ts
interface AnalysisModePlugin<Config, Input, Result> {
  definition: AnalysisModeDefinition;
  configSchemaVersion: number;
  resultSchemaVersion: number;
  validateConfig(input: unknown): Config;
  analyze(input: Input, config: Config, signal: AbortSignal): Promise<Result>;
}
```

It must also supply capability requirements, input provenance, resource bounds, cancellation latency, typed progress/results/errors, empty-result semantics, deterministic fixtures, a workspace manifest, schema migrations, and security review for external packages.

Plugins cannot receive `ByteTransport`, `TinySaDevice`, Electron IPC, filesystem handles, or generator methods. Device acquisition is orchestrated by the host from declared input requirements.

## 11. Visual and interaction contract

The visual system is **atomic precision**: warm carbon surfaces, mineral-white typography, a spectral measurement trace, and a restrained orbital signature. It is not a terminal skin and does not depend on a phosphor metaphor.

- Energy mint: live measurement, selected navigation, verified healthy connection.
- Spectral cyan-to-violet: measured trace continuity and Atom identity; never a safety state.
- Violet: Atom voice, reasoning, tool and approval context.
- Amber: detection evidence, experimental/model-gated state, caution.
- Red: RF output on, unsafe/unknown output, destructive action, blocking fault.
- Monospace: measurements, units, versions, IDs, protocol/evidence metadata.
- Proportional type: navigation, commands, headings and explanations.

### 11.1 Spatial rules

1. At the 1920 × 1100 reference viewport, Spectrum has exactly one dominant measurement plane and no workspace scroll. Its rendered area exceeds any control surface.
2. Analyzer settings form one horizontal overlay. They do not become a competing inspector column or change stage height at the reference viewport.
3. Navigation is an instrument rail no wider than 104 CSS px. Core destinations remain labeled; icon-only navigation is forbidden.
4. Atom is visually detached with a bounded 404 CSS px width. At widths at or above 1430 px the workspace reserves 438 px while Atom is open.
5. Metrics are integrated with the measurement plane and update atomically with the trace.
6. Empty space is allowed. It is not filled with decorative cards, inactive charts, upcoming destinations, or nonfunctional controls.
7. Borders establish containment only. Nested surfaces must not produce more than two simultaneous visible containment levels.
8. The custom orbital mark is the product signature and may appear in brand, Atom, voice, and empty states. It may not replace warning, RF, or error semantics.

### 11.2 Motion and material rules

- Blur is confined to persistent chrome, dialogs, and Atom; measurement pixels stay sharp.
- Glow indicates a live measured or connected state only and remains subordinate to text.
- Atom/orbital animation honors reduced motion and never blocks input.
- Every visible button performs its labeled action. Placeholder controls are omitted instead of simulated.
- The plot marker binds to an actual sweep bin and exposes its exact power/frequency as text.

Color is redundant with text/icon/shape. Contrast targets WCAG 2.2 AA. Reference window is 1920 × 1100 CSS px; the measured no-scroll content minimum is 1532 × 821 where the display work area permits it. That floor admits the two-column Device view with Atom reserved and all 34 embedded SignalLab profiles with Rayleigh controls. Scaling is tested at 100%, 150% and 200%. Controls acknowledge activation within 100 ms; operation labels update within 150 ms.

## 12. Accessibility contract

- Header, navigation, main workspace, status/footer, and dialog landmarks.
- Visible focus on every interactive item.
- Dialog focus trap, Escape where safe, and focus restoration.
- Route changes focus the workspace heading without stealing focus during live updates.
- Live regions announce connection, operation completion/failure and RF transitions, not raw sweep updates.
- Plot has a textual summary and keyboard marker table.
- Motion honors `prefers-reduced-motion`.
- RF and error states use text plus icon/shape, not color alone.

## 13. Acceptance inventory

### Connection

- **CON-01:** Empty discovery is actionable.
- **CON-02:** Refresh updates candidates without duplicates.
- **CON-03:** A missing, stale-exact, or ambiguous preferred candidate explains the state and never auto-connects another source; only an absent preference file authorizes exact `signal-lab:default`.
- **CON-04:** Connect submits once.
- **CON-05:** Source-specific admission and provenance validation precede ready.
- **CON-06:** Unsupported/custom firmware explains degraded capabilities without inventing qualification.
- **CON-07:** Driver unavailable, bridge mismatch, busy-port, and permission errors have distinct remediation.
- **CON-08:** Unplug rejects current work and updates global state.
- **CON-09:** Reconnect never resumes acquisition automatically.
- **CON-10:** Reconnect never restores generator output.
- **CON-11:** Dialog keyboard/focus behavior passes.
- **CON-12:** Device strings render as text, not HTML.

### Spectrum

- **SPC-01:** Engineering-unit parsing resolves to exact integer Hz.
- **SPC-02:** Invalid/reversed range causes no IPC request.
- **SPC-03:** Capabilities govern ranges.
- **SPC-04:** Configure precedes acquire.
- **SPC-05:** Sweep arrays are equal length and finite.
- **SPC-06:** Actual bins drive x-axis.
- **SPC-07:** Metrics update atomically with trace.
- **SPC-08:** Previous trace is visibly stale on failure.
- **SPC-09:** Simulated data is persistently labeled/exported as simulated.
- **SPC-10:** Thirty-minute stream has bounded memory/responsive UI.
- **SPC-11:** Four traces accumulate with the exact contracted bin semantics.
- **SPC-12:** Eight markers bind to assigned trace bins and expose textual values.
- **SPC-13:** Delta/noise/search failures preserve state and explicit units.
- **SPC-14:** Reference level and dB/div affect only host display projection.
- **SPC-15:** Expanded Markers, Traces, and Display surfaces do not overflow at the reference viewport with Atom open.
- **SPC-16:** The active marker card is a structural sibling of the SVG plot canvas and remains readable for left, center, and right peaks.
- **SPC-17:** A 3 dB bracket is rendered only when both bounded crossings exist; unavailable results show dashes and no bracket without suppressing component-local 99% OBW, while nonmonotone half-power islands do not suppress an independently qualified bounded-wideband centroid.
- **SPC-18:** CW-like narrow placement remains on the sampled peak; any available local width is resolution-limited and a missing crossing remains unavailable. Marker shape and signal/noise context use assigned-trace evidence and RBW/grid resolution, not protocol labels, calibrated-SNR wording, 99% OBW, or aggregate agile-signal support.
- **SPC-19:** Mismatched, nonfinite, nonincreasing, or degenerate trace geometry is quarantined before marker, reducer, and render projection and cannot crash the renderer.
- **SPC-20:** Every admitted React trace/marker/display update redraws SVG geometry from the current validated state; no static plot asset or screenshot can become measurement evidence.

### Detection

- **DET-01:** Adaptive threshold equals declared floor plus margin.
- **DET-02:** Absolute threshold observes exact dBm.
- **DET-03:** Contiguous bins segment deterministically.
- **DET-04:** Minimum bandwidth uses actual frequencies.
- **DET-05:** Zero result differs from missing/failed analysis.
- **DET-06:** Bands, table and detail synchronize.
- **DET-07:** Results contain detector config/version and provenance.
- **DET-08:** Track updates use the declared two-state filter; missed sweeps
  expose transition-predicted state without an invented miss likelihood, and
  correlated looks are not blindly multiplied.
- **DET-09:** Cancellation is bounded.
- **DET-10:** Quality report covers agreed captured corpus.
- **DET-11:** Only Detect renders current active physical bandwidth/midpoint annotations; Spectrum renders neither even when it receives the same detection count data.
- **DET-12:** A predictive-tail target is never presented as an achieved
  per-sweep or per-hour false-alarm probability without physical calibration.
- **DET-13:** Auto selects the eligible current physical target with greatest
  current-source-sweep integrated excess power from the exact visible sweep,
  excludes stale/off-span/synthetic summary evidence,
  and uses deterministic tie-breaking; explicit selection and Auto state remain
  distinguishable.

### Classification

- **CLS-01:** Missing or runtime-rejected classifier assets yield localized
  unavailable/unknown, never a label or startup failure; acquisition, detection,
  Spectrum/Waterfall/Channel, Generate, and Device retain their independent
  availability.
- **CLS-02:** Candidate retains detection/sweep provenance.
- **CLS-03:** Invalid model package cannot execute/install.
- **CLS-04:** Out-of-domain capture warns/rejects.
- **CLS-05:** Results identify model/preprocessing versions.
- **CLS-06:** Synthetic posteriors are labeled uncalibrated; calibrated
  confidence requires a published physical protocol.
- **CLS-07:** Fitted-unknown and scenario-excluded unknown samples are reported
  separately, with strict holdout, ambiguity, exact-equivalence, and known
  acquisition-only partitions preserved; none is described as a physical open
  set.
- **CLS-08:** UI shows ranked candidates and unknown reason.
- **CLS-09:** Inference cancellation/resource bounds pass.
- **CLS-10:** Repeated inference is deterministic within tolerance.
- **CLS-11:** Live waveform labels state evidence equivalence, omit replay
  wording, and retain `NOT PROTOCOL` qualification.
- **CLS-12:** Unknown is normalized with known leaves and remains visible in the
  ranked result.
- **CLS-13:** Classification uses the detector-frozen, provenance-bound region
  without a second 3 dB feature-admission gate; any frequency-agile association
  region is separate provenance and never replaces the frozen emission region.
- **CLS-14:** Bluetooth labels disclose the provisional 2.4 GHz band-activity
  association and fixed-frequency zero-span limitations; no transmitter/link,
  cross-channel hop-sequence, advertising-triplet, or link-wide slot-cadence
  claim is made, and absent separately provenance-bound distinguishing evidence
  the result remains Bluetooth-like or `unknown`.
- **CLS-15:** A regular-component association is classification-only, abstains
  on ambiguous membership, expires independently, retains both local and group
  provenance, requires exactly eight association looks, produces one UI result
  per group, and never asserts common-emitter identity.
- **CLS-16:** Wireless hard eligibility masks test the measured occupied
  interval rather than center alone and describe fitted-model support, not a
  universal standards prohibition.
- **CLS-17:** Full-band 2.4 GHz evidence displays the 96-opportunity horizon;
  BLE non-admission remains separate from conditional classification and is not
  presented as a negative protocol observation.
- **CLS-18:** LTE/NR at nominal bandwidths of 20 MHz or less may not be upgraded
  beyond the documented cellular-OFDM ambiguity without a qualified
  distinguishing observation.
- **CLS-19:** An exact-equivalence or ambiguity scenario may display only a
  declared compatible evidence class or `unknown`; the UI never forces a unique
  source story from indistinguishable scalar evidence.
- **CLS-20:** Wi-Fi diagnostic leaf posteriors never become a primary PHY label;
  the primary result is `802.11-compatible channel morphology · PHY unresolved`
  or `unknown`, with `NOT PROTOCOL` qualification.
- **CLS-21:** A multicomponent swept-region result visibly preserves at least
  four independent local Bayesian admissions, its containment-or-raster
  qualification, latest hull/membership, latest-eight same-geometry
  padded-IoU/shared-center history, and local-only zero span. UI history may
  reconnect only inside release hysteresis and cannot revive an expired lineage; it makes no
  simultaneity, common-process, or emitter-identity claim.

### Generator

- **GEN-01:** Start/connect/reconnect/import/preset never enable output.
- **GEN-02:** Configure commands off before mode/frequency/level.
- **GEN-03:** Enable requires known capabilities/valid values.
- **GEN-04:** RF on stays globally visible.
- **GEN-05:** Navigation away while on is blocked.
- **GEN-06:** Cable loss while on becomes unknown.
- **GEN-07:** Unknown never decays to off.
- **GEN-08:** Duplicate enable produces one operation.
- **GEN-09:** Clean disconnect/quit attempts off and records outcome.
- **GEN-10:** Hardware qualification checks representative output.
- **GEN-11:** SignalLab selection renders the shared six-family Studio and no RF-output control.
- **GEN-12:** Studio profile/channel intent crosses the admitted driver boundary and never becomes classifier evidence.

### Complex I/Q

- **IQ-01:** I/Q is absent unless the active session advertises `complex-iq`.
- **IQ-02:** Configuration respects every advertised lattice and bandwidth-coupling rule.
- **IQ-03:** Mismatched session/revision, kind, format, count, or byte geometry is rejected without replacing the last valid capture.
- **IQ-04:** Preview work is bounded and rejects non-finite sampled components.
- **IQ-05:** Time and constellation plots make no decoding, EVM, protocol, calibration, or compliance claim.
- **IQ-06:** SignalLab exposes deterministic I/Q for all 34 closed profiles, preserves analytic-laboratory versus standards-derived-engineering qualification, and makes no packet-decoding or conformance claim for standards-labelled buffers.
- **IQ-07:** Complete-buffer v1 never presents itself as streaming or continuous hardware support.
- **IQ-08:** Time and constellation previews share bounded 0.5×–8× zoom and explicit Fit reset controls; every control is keyboard accessible and no breakpoint turns the plot grid into a scrolling container.

### Atomic frame

- **ATM-01:** Reference viewport preserves one dominant measurement plane with Atom open.
- **ATM-02:** Spectrum setup remains one horizontal command dock without clipping or overlap.
- **ATM-03:** Closing Atom returns its reserved width to the workspace without remounting device state.
- **ATM-04:** All six core route labels remain visible; I/Q appears only for an advertised capability, and active-route state is textual.
- **ATM-05:** No rendered control is a nonfunctional visual placeholder.
- **ATM-06:** Connected 450-point sweep renders exact trace, axes, peak marker and six metric groups without overflow.
- **ATM-07:** Detect and Generate retain the same tokens, spacing, status semantics and Atom layer.
- **ATM-08:** Reduced motion disables orbital, voice-ring, sweep and drawer animations.
- **ATM-09:** Simulated provenance remains visible in top bar and status contract.
- **ATM-10:** Screenshot review fixtures cover disconnected Spectrum and connected Spectrum/Waterfall/Channel/Detect/Generate/Device at the reference viewport.
- **ATM-11:** Spectrum, Waterfall, and Channel each remain fully visible with Atom open and without workspace scrolling; no Time/STFT renderer route is present.
- **ATM-12:** macOS traffic lights are native, integrated into the carbon top bar, and never overlap the brand or draggable controls.
- **ATM-13:** The global acquisition rail remains visible in the sidebar across every route, never duplicates Run/Single in a workspace header, and fits the minimum supported viewport without scrolling.

## 14. Delivery decomposition

| Package | Outcome | Depends on | Acceptance |
|---|---|---|---|
| UX-00 | Tokens, primitives, frame, accessibility harness | contracts | XP rules; scale review |
| UX-01 | Connection/global state | driver registry and `AtomizerInstrumentApiV1` | CON-01..12 |
| UX-02 | Spectrum configuration/acquisition | analyzer service | SPC-01..10 |
| UX-03 | Live Spectrum renderer, four traces, eight markers, Waterfall, Channel, and non-rendered envelope-STFT engine | measured throughput | SPC-11..20; MEAS-001..29; ADV-001..18; performance/a11y |
| UX-04 | Merged Detect localization, configuration, sweep segmentation, and Auto targeting | sweeps | DET-01..07,09,11..13 |
| UX-05 | Cross-sweep tracker and alerts | bounded stream | DET-08,10 |
| UX-06 | Classification pipeline and unknown UX | detections/model manifest | CLS-01..05,08,09 |
| ML-01 | Corpus/taxonomy/capture protocol | hardware/RF lab | versioned labeled data |
| ML-02 | Baselines/training/calibration | ML-01 | reproducible evaluation |
| ML-03 | Signed local model/inference | ML-02 | CLS-03..10 |
| UX-07 | Guarded generator | characterized API | GEN-01..10 |
| UX-08 | Remote screen/touch | binary fixtures | pixel/coordinate/priority tests |
| UX-09 | Sessions/export/comparison | session schema | reproducibility/migrations |
| UX-10 | Diagnostics/settings/help | error catalog | recovery/support tests |
| UX-11 | Accessibility/usability qualification | stable workflows | operator studies |

UX-00/01/02/03/04/05/06/07/08 and the export portion of UX-09 have an implemented vertical slice. Hardware clauses, complete keyboard marker workflow, durable session persistence, comparison, limit lines/emission masks, harmonic orchestration, and support bundles remain open.

## 15. Traceability to current source

| Contract area | Implementation |
|---|---|
| Global workspace state | `apps/desktop/src/renderer/App.tsx` |
| UI state/transitions | `apps/desktop/src/renderer/ui-contracts.ts` |
| Exact unit parsing | `apps/desktop/src/renderer/format.ts` |
| Connection | `components/TopBar.tsx`, `components/ConnectionDialog.tsx` |
| Navigation/global RF | `components/Sidebar.tsx` |
| Spectrum measurements | `components/MeasurementWorkspace.tsx`, `SpectrumPlot.tsx`, `WaterfallView.tsx`, `ChannelAnalysisView.tsx`, `AnalyzerInspector.tsx`, `MeasurementDock.tsx`, `packages/analysis` |
| Execution admission | `packages/instrument-runtime/src/instrument-driver-registry.ts`, `packages/instrument-runtime/src/instrument-manager.ts`, `packages/signal-lab-driver/src/signal-lab-instrument-driver.ts`, `packages/tinysa/src/tinysa-instrument-driver.ts`, `apps/desktop/src/main/atomizer-instrument-host.ts` |
| Trio/driver/SignalLab topology | `contracts/trio-composition-v4.json`, `packages/contracts/src/instrument.ts`, `packages/agent/src/index.ts` |
| Detection and classification | `components/ClassificationWorkspace.tsx`, `packages/analysis` |
| Complex I/Q | `components/IqWorkspace.tsx`, `apps/desktop/src/renderer/complex-iq.ts`, `packages/contracts/src/instrument.ts` |
| Generator / embedded SignalLab Studio | `components/GeneratorWorkspace.tsx`, `apps/desktop/src/renderer/signal-lab-studio.ts`, `../Atom-SignalLab/src/SignalLabStudio.tsx`, `packages/signal-lab-driver`, `packages/tinysa` |
| Device diagnostics/screen/touch | `components/DeviceWorkspace.tsx`, `packages/tinysa` |
| CSV/JSON export | `apps/desktop/src/main/sweep-export.ts`, `main.ts` |
| Visual tokens/layout | `apps/desktop/src/renderer/styles.css` |
| Product orbital signature | `components/AtomicMark.tsx` |

## 16. Definition of done

A workspace is done only when happy path, empty, loading, stale, unavailable, invalid, failure, disconnect and recovery states are implemented; keyboard and assistive semantics pass; inputs validate before IPC; results contain provenance; layout passes supported dimensions/scaling; automated acceptance IDs are traceable; hardware clauses pass the frozen firmware profile; and released documentation matches the UI.
