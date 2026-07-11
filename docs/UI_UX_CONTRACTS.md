# TinySA Atomizer UI/UX and Analysis Contracts

Status: execution baseline  
Version: 2.0.0
Updated: 2026-07-10

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
| XP-05 | Evidence over certainty | Detection and classification results carry source sweeps, settings, timestamps, device/firmware, and confidence/evidence. |
| XP-06 | Recoverable interruption | Unplug, timeout, cancellation, window reload, and invalid input end in an actionable state without an indefinite spinner. |
| XP-07 | Local and private | No remote font, asset, telemetry, inference, or account dependency exists in v1. |
| XP-08 | Keyboard complete | Every core workflow is achievable without a pointer. |

## 2. Information architecture

### 2.1 Persistent application frame

The frame contains five regions:

- **Top bar:** product identity, environment badge, instrument connection control, and Atom entry point.
- **Primary navigation:** only implemented Observe, Analyze, and Generate destinations; unfinished destinations are not rendered as dead affordances.
- **Workspace:** route-specific header, actions, errors, connection guidance, content and inspector.
- **Status bar:** connection, device/firmware, trace state, verification state, API version.
- **Atom rail:** native voice/text agent, tool activity, approvals, and instrument-aware suggestions.

These regions remain mounted across workspace changes. Generator output `on` or `unknown` must remain visible in the navigation and top-level status treatment regardless of active workspace.

Atom is governed by `AI_NATIVE_CONTRACTS.md`. At the reference width it is a detached intelligence layer and the workspace reserves its full footprint, so the active trace is never hidden. Below the reference width Atom becomes an explicit overlay that the operator can close; it must not silently cover a high-impact approval or RF state. The exact model identity, reasoning effort, transport, and configured/listening/thinking/speaking state remain visible.

### 2.2 Workspace routes

| Route | ID | Primary outcome | v1 status |
|---|---|---|---|
| Spectrum | WS-SPC | Configure and acquire a trace | Core |
| Detection | WS-DET | Find and inspect emissions | Core |
| Classification | WS-CLS | Characterize spectral morphology and zero-span envelope evidence | Experimental core; validated modulation/protocol model gated |
| Generator | WS-GEN | Configure and deliberately enable RF output | Software core; physical qualification pending |
| Device | WS-DEV | Inspect identity/telemetry and operate screen capture/touch | Core; physical qualification pending |

Durable saved sessions, comparison, waterfall, settings, and support-bundle workflows remain contracted work, but are omitted from navigation until functional. Spectrum provides bounded in-memory history and native CSV/JSON export now.

### 2.3 Signal Lab companion

When startup discovery completes successfully but contains no exact `0483:5740` ZS407 candidate, main may expose and auto-connect one explicit synthesized ZS407. This is a declared demo environment, not a recovery fallback. A compact second BrowserWindow contains exactly four primary choices—CW, AM, FM, and LTE-like—and changes the simulator's actual text/raw/zero-span byte source. Selecting a profile requests a new main-window sweep unless continuous acquisition is already consuming the source. An exact physical candidate suppresses Signal Lab startup. Discovery failure does not activate it.

LTE-like means a deterministic flat occupied channel with OFDM-like texture; it is not standards-compliant LTE I/Q and the UI must retain that qualifier. Atom receives a typed `select_demo_signal` hook. The app-only coordinate harness remains scoped to the main window.

## 3. Global state contracts

### 3.1 Connection state

```text
disconnected -> discovering -> selecting -> connecting -> identifying -> ready
      ^                                                       |
      |                    recovering <------------------------+
      +---------------------- faulted <------------------------+
```

| State | UI obligation | Allowed actions | Forbidden claims |
|---|---|---|---|
| Disconnected | “No instrument”; show connect action | Refresh, select, connect, inspect saved sessions | Current device state, verified settings |
| Discovering | Bounded progress and cancel | Cancel | Device absent until discovery completes |
| Selecting | List all candidates with path/identity | Refresh, choose, connect, cancel | Automatically identifying a candidate as genuine solely by VID/PID |
| Connecting | Disable duplicate connect; show chosen port | Cancel if transport supports it | “Ready” |
| Identifying | Show protocol negotiation | Disconnect/cancel | Supported capabilities until resolved |
| Ready | Show identity, firmware, capability state | Supported operations | Verification not supplied by firmware |
| Recovering | Show cause and attempt count | Cancel reconnect | Silent operation resumption |
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

## 4. Connection workflow contract

### UX-CONNECT-01 — Select and connect

**Trigger:** connection pill, connection banner, or first-run action.  
**Inputs:** enumerated `PortCandidate[]`, optional remembered candidate ID.  
**Output:** identified `DeviceSnapshot` or typed failure.  
**States:** loading, no ports, candidate list, connecting, connected, failed.

Rules:

- Remembered candidates are preselected but never connected without user action in v1.
- Each option shows human label, OS path, and serial number when present.
- Refresh retains selection only if the same candidate ID remains.
- Connecting disables refresh, candidate changes, and duplicate submissions.
- On success, focus returns to the triggering control and the dialog closes.
- On failure, the dialog remains open and explains permission, busy-port, unsupported-device, timeout, or transport causes distinctly.

## 5. Spectrum workspace contract

### UX-SPC-01 — Configure range

Inputs are start/stop or center/span in integer Hz and capability limits. Stop must exceed start. Editing one representation updates the other only after a valid commit. Invalid text remains editable with an inline message and never reaches IPC. Quick ranges are named presets with inspectable values.

### UX-SPC-02 — Configure sweep

Inputs include points, resolution bandwidth, attenuation and later accepted detector/trace controls. “Automatic” is a typed value, not `0` or an empty string. Unsupported options are absent with an inspectable reason, not merely disabled without explanation.

### UX-SPC-03 — Acquire once

1. Validate locally.
2. Send typed analyzer configuration.
3. Show `configuring`.
4. On success, request one sweep and show `acquiring`.
5. Atomically replace the trace when arrays and provenance validate.
6. Update peak, noise floor, detections, range, age and verification state together.

An incomplete or mismatched sweep never partially paints.

### UX-SPC-04 — Plot interaction

- X axis is actual frequency; Y axis is power in the selected unit.
- Axis endpoints and units are always visible.
- Zoom/pan never changes device configuration until an explicit “acquire this range” action.
- Markers are keyboard reachable and expose frequency/power text.
- A stale trace remains visible with a stale badge.
- Simulated data carries a persistent environment badge and export provenance.
- At reference throughput, pointer/keyboard interactions target p95 latency below 100 ms.

## 6. Signal Detection mode contract

Detection consumes immutable sweeps and emits immutable `DetectedSignal[]`. It cannot access serial, IPC, files, React, or generator operations.

Required configuration:

```ts
type DetectionThreshold =
  | { strategy: 'absolute'; levelDbm: number }
  | { strategy: 'noise-relative'; marginDb: number };

interface SignalDetectionConfig {
  threshold: DetectionThreshold;
  minimumBandwidthHz: number;
  minimumConsecutiveSweeps: number;
  releaseAfterMissedSweeps: number;
}
```

Required result fields: stable event ID, start/stop/peak frequencies, peak power, estimated bandwidth, first/last timestamps, source sweep IDs, detector version/configuration, and quality flags.

### UX-DET-01 — Configure detector

- Adaptive threshold displays estimated floor and margin separately.
- Absolute threshold displays dBm.
- Minimum bandwidth and persistence declare exact units.
- Changes affect subsequent analysis; re-analysis of existing data is explicit and records the new config.

### UX-DET-02 — Display detections

- Detection bands appear on the plot without obscuring the trace.
- Event table provides status, peak frequency, power, bandwidth, age, and inspect action.
- Selected event synchronizes plot highlight, detail panel, and classification candidate.
- Zero events is a valid outcome, distinct from “not analyzed” and “analysis failed.”

### UX-DET-03 — Track across sweeps

Tracking is a separate stateful stage from sweep-local segmentation. `SignalTracker` v2 greedily associates highest-score candidates by occupied-range overlap and peak-frequency distance bounded by three bins or observed bandwidth. It promotes a stable ID after `minimumConsecutiveSweeps`, records missed sweeps, emits one explicit `released` result after the configured miss window, and then removes the track. Configuration changes reset the tracker rather than rewriting prior provenance. Merge/split policy remains one-to-one best match and must change version if revised.

Before claiming production detection quality, publish event-level precision/recall, false alarms per sweep/hour, detection probability versus SNR, frequency/bandwidth error, performance by capture configuration, and boundary/overlap behavior.

## 7. Waveform Classification mode contract

Classification comprises three explicitly separated evidence levels:

1. **Spectral morphology:** deterministic labels for narrow carrier, multi-carrier, wideband noise-like, and band-limited trace shape. Implemented as experimental evidence; it is not a modulation or protocol claim.
2. **Zero-span envelope:** deterministic steady, amplitude-varying, or pulsed detected-power behavior. Implemented; zero span is not I/Q.
3. **Validated modulation/protocol classifier:** taxonomy, labeled corpus, training pipeline, calibrated model, evaluation and supported-domain statement. Hardware/data gated.

### UX-CLS-01 — Pipeline visibility

Capture, detect, and characterize stages are independently `waiting | ready | running | complete | failed | unavailable`. A future validated model being absent does not invalidate deterministic morphology/envelope evidence and never permits a stronger label.

### UX-CLS-02 — Candidate selection

Each candidate shows its source detection, frequency, bandwidth, power, time window and capture sufficiency. Selecting a candidate never mutates analyzer or generator state.

### UX-CLS-03 — Result

Required presentation:

- Primary label or `unknown`.
- A relative score for heuristic morphology/envelope, or calibrated confidence only for a validated model.
- Ranked candidates with scores.
- Unknown reason: low confidence, out-of-domain, insufficient evidence, model unavailable, or inference failure.
- Model ID/version/hash and preprocessing version.
- Evidence link to source sweeps.
- Domain warning when capture parameters fall outside validation.

### Model package contract

A model package is inert data plus declared inference metadata; it cannot execute arbitrary scripts. It contains a signed manifest, asset hash, taxonomy, preprocessing graph ID, input shape/ranges, supported device/firmware/capture domain, validation metrics and license. Installation validates size, schema, signature policy and hashes in the trusted process.

### Classification quality contract

- Dataset splits are grouped by physical capture session and source device to prevent leakage.
- Evaluation includes an explicit open-set corpus absent from training classes.
- Report per-class precision, recall, F1, support, confusion matrix, macro metrics, expected calibration error and coverage-risk curve.
- “State of the art” is comparative: record baselines, dataset version, compute budget and evaluation protocol.
- Learned modulation/protocol thresholds are frozen after corpus characterization; before then the only conforming learned-model outcome is `unknown`. Heuristic morphology/envelope results remain visibly experimental and use relative scores, never calibrated-confidence copy.

## 8. Generator workspace contract

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
| `Sidebar` | route, output state, capabilities | route intent | active, unavailable, RF on/unknown | guarded navigation, current page |
| `ConnectionDialog` | candidates, selection, busy, error | refresh/select/connect/disconnect/close | empty, list, connecting, connected, failed | focus trap/restore, duplicate submit |
| `SpectrumPlot` | sweep, detections, busy, freshness | zoom/pan/marker intents | empty, loading, live, stale | exact bins, axes, resize, performance |
| `AnalyzerInspector` | config, capabilities, busy | validated config change | auto/manual, invalid, unsupported | units, ordered range, operation lock |
| `MetricStrip` | sweep, events, operation | none | empty/current/stale | atomic update, units |
| `DetectionWorkspace` | sweep, config/results | config/select/reanalyze | not analyzed, zero, result, failure, tracking | semantics and provenance |
| `ClassificationWorkspace` | candidates, pipeline/model/result | select/install/classify | no capture, no candidates, no model, running, unknown, result, failure | no invented certainty |
| `GeneratorWorkspace` | config, snapshot/capabilities | apply, enable, disable | disconnected, invalid, off, enabling, on, disabling, unknown | safety transitions |
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

1. At the 1580 × 948 reference viewport, Spectrum has exactly one dominant measurement plane. Its rendered area exceeds any control or agent surface.
2. Analyzer settings form one horizontal command dock. They do not become a competing inspector column at the reference viewport.
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

Color is redundant with text/icon/shape. Contrast targets WCAG 2.2 AA. Reference window is 1580 × 948 CSS px; minimum is 1120 × 720. Scaling is tested at 100%, 150% and 200%. Controls acknowledge activation within 100 ms; operation labels update within 150 ms.

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
- **CON-03:** Missing remembered candidate leaves selection unset, explains the state, and never auto-connects.
- **CON-04:** Connect submits once.
- **CON-05:** Identification precedes ready.
- **CON-06:** Unsupported firmware explains degraded capabilities.
- **CON-07:** Busy and permission errors have distinct remediation.
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

### Detection

- **DET-01:** Adaptive threshold equals declared floor plus margin.
- **DET-02:** Absolute threshold observes exact dBm.
- **DET-03:** Contiguous bins segment deterministically.
- **DET-04:** Minimum bandwidth uses actual frequencies.
- **DET-05:** Zero result differs from missing/failed analysis.
- **DET-06:** Bands, table and detail synchronize.
- **DET-07:** Results contain detector config/version and provenance.
- **DET-08:** Tracking UI remains unavailable until tracker exists.
- **DET-09:** Cancellation is bounded.
- **DET-10:** Quality report covers agreed captured corpus.

### Classification

- **CLS-01:** Missing model yields unavailable/unknown, never a label.
- **CLS-02:** Candidate retains detection/sweep provenance.
- **CLS-03:** Invalid model package cannot execute/install.
- **CLS-04:** Out-of-domain capture warns/rejects.
- **CLS-05:** Results identify model/preprocessing versions.
- **CLS-06:** Confidence is calibrated under published protocol.
- **CLS-07:** Open-set samples participate in acceptance.
- **CLS-08:** UI shows ranked candidates and unknown reason.
- **CLS-09:** Inference cancellation/resource bounds pass.
- **CLS-10:** Repeated inference is deterministic within tolerance.

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

### Atomic frame

- **ATM-01:** Reference viewport preserves one dominant measurement plane with Atom open.
- **ATM-02:** Spectrum setup remains one horizontal command dock without clipping or overlap.
- **ATM-03:** Closing Atom returns its reserved width to the workspace without remounting device state.
- **ATM-04:** All five route labels remain visible and active-route state is textual.
- **ATM-05:** No rendered control is a nonfunctional visual placeholder.
- **ATM-06:** Connected 450-point sweep renders exact trace, axes, peak marker and six metric groups without overflow.
- **ATM-07:** Detection, Classification and Generator retain the same tokens, spacing, status semantics and Atom layer.
- **ATM-08:** Reduced motion disables orbital, voice-ring, sweep and drawer animations.
- **ATM-09:** Simulated provenance remains visible in top bar and status contract.
- **ATM-10:** Screenshot review fixtures cover disconnected Spectrum and connected Spectrum/Detection/Classification/Generator/Device at the reference viewport.

## 14. Delivery decomposition

| Package | Outcome | Depends on | Acceptance |
|---|---|---|---|
| UX-00 | Tokens, primitives, frame, accessibility harness | contracts | XP rules; scale review |
| UX-01 | Connection/global state | transport/device API | CON-01..12 |
| UX-02 | Spectrum configuration/acquisition | analyzer service | SPC-01..10 |
| UX-03 | Plot, marker and waterfall engine | measured throughput | performance/a11y |
| UX-04 | Detection configuration and sweep segmentation | sweeps | DET-01..07,09 |
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

UX-00/01/02/04/05/06/07/08 and the export portion of UX-09 have an implemented vertical slice. Hardware clauses, durable session persistence, comparison, waterfall, and support bundles remain open.

## 15. Traceability to current source

| Contract area | Implementation |
|---|---|
| Global workspace state | `apps/desktop/src/renderer/App.tsx` |
| UI state/transitions | `apps/desktop/src/renderer/ui-contracts.ts` |
| Exact unit parsing | `apps/desktop/src/renderer/format.ts` |
| Connection | `components/TopBar.tsx`, `components/ConnectionDialog.tsx` |
| Navigation/global RF | `components/Sidebar.tsx` |
| Spectrum | `components/SpectrumPlot.tsx`, `components/AnalyzerInspector.tsx` |
| Detection | `components/DetectionWorkspace.tsx`, `packages/analysis` |
| Classification | `components/ClassificationWorkspace.tsx`, `packages/analysis` |
| Generator | `components/GeneratorWorkspace.tsx`, `packages/tinysa` |
| Device diagnostics/screen/touch | `components/DeviceWorkspace.tsx`, `packages/tinysa` |
| CSV/JSON export | `apps/desktop/src/main/sweep-export.ts`, `main.ts` |
| Visual tokens/layout | `apps/desktop/src/renderer/styles.css` |
| Product orbital signature | `components/AtomicMark.tsx` |

## 16. Definition of done

A workspace is done only when happy path, empty, loading, stale, unavailable, invalid, failure, disconnect and recovery states are implemented; keyboard and assistive semantics pass; inputs validate before IPC; results contain provenance; layout passes supported dimensions/scaling; automated acceptance IDs are traceable; hardware clauses pass the frozen firmware profile; and released documentation matches the UI.
