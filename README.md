# TinySA Atomizer

TinySA Atomizer is an AI-native Electron instrument host. It owns operator intent, instrument selection and lifecycle, measurement projections, and Atom—the application-layer voice and tool-using RF agent. Its current drivers compose SignalLab and the tinySA Ultra+ ZS407 without flattening synthetic measurements, physical USB, or executable firmware into the same evidence class.

The live system is deliberately split into four independently versioned repositories:

| Repository | Sole owner | Current edge |
|---|---|---|
| `TinySA` | Operator app, instrument host, physical USB, measurement analysis, Atom policy and approvals | Hosts the active SignalLab and `tinysa-zs407` drivers |
| `TinySA_Firmware` | Pinned executable Renode twin and bridge | Selectable through the `tinysa-zs407` driver |
| `TinySA_SignalLab` | High-level synthetic measurement producer, scalar-classification corpus, visual waveform descriptors, seeded channel models, stimulus intent | Active versioned NDJSON measurement edge to Atomizer; Firmware stimulus sink remains reserved |
| `TinySA_Flasher` | Standalone physical firmware discovery, preflight, DFU, write journaling, and recovery | Active interface catalog v3 retaining active application contract v2 (`deviceContractVersion: 2`); interface catalog v2 and legacy application contract v1 frozen; no Atomizer runtime edge |

The normative Atomizer/Firmware/SignalLab runtime composition is byte-identical in those three repositories at [trio-composition-v4.json](./contracts/trio-composition-v4.json). Physical USB, the Renode monitor bridge, and SignalLab simulation are never represented as the same transport or evidence class. Firmware installation is outside that runtime graph and belongs exclusively to the standalone sibling application at `../TinySA_Flasher`; Atomizer does not download firmware, enter DFU, or expose a flash API.

USB ownership is session-scoped: Atomizer owns CDC analyzer/generator operation, while TinySA Flasher owns CDC discovery and preflight, DFU admission and write, and CDC post-write verification for the complete firmware-update session. The two applications must never access the same physical device simultaneously. Disconnect or close Atomizer before opening a Flasher update session, and finish or safely exit that session before reconnecting Atomizer.

## Run

Requirements:

- Node.js 22.23.1 and npm 10.9.8 (the versions pinned by CI).
- `../TinySA_SignalLab`, whose separately built measurement bridge is the factory-default instrument source and whose corpus is pinned by the Bayesian observable-class model.
- The sibling Firmware repository at `../TinySA_Firmware`, plus Renode and its pinned twin dependencies, when selecting the executable twin.
- `../TinySA_Flasher` and its declared prerequisites only when performing a physical firmware update; they are not Atomizer runtime dependencies.

```bash
npm install
npm run check
npm run dev
```

Startup follows one closed admission rule across the static driver registry:

1. Discover every registered driver independently and retain driver-scoped failures.
2. Load the owner-only version-1 instrument preference. With no preference file, select the `signal-lab` driver as the explicit factory default.
3. Match exactly one candidate owned by the preferred driver and optional source kind. Missing or ambiguous matches fail visibly.
4. Connect only that candidate. Discovery, bridge, identity, malformed-firmware, required-command, or twin boot/evidence failure is terminal for the admission attempt and never falls through to another source.
5. An operator may explicitly make SignalLab, a physical ZS407, or the executable twin the new default after the active session is safely disconnected. A syntactically valid unknown physical revision is admitted only as `custom-unqualified`, with persistent warning and no invented source provenance.

The executable twin boots the pinned `lab-v0.2.0-protocol` firmware in Renode. Its sweeps, LCD framebuffer, touch behavior, and generator state come from executable firmware. Its transport is `renode-monitor-bridge`; USB transactions are explicitly not modeled.

The byte-level test device in `packages/test-device` is test-only. It is not a runtime fallback.

## SignalLab

SignalLab is a separate application and Git repository. Atomizer builds and launches its version-1 high-level measurement bridge for the `signal-lab` driver:

```bash
npm --prefix ../TinySA_SignalLab install
npm --prefix ../TinySA_SignalLab run build:bridge
npm --prefix ../TinySA_SignalLab run dev
```

It owns 79 legacy visual stimulus profiles, deterministic AWGN/Rayleigh channel
configuration, and the separate immutable 35-scenario
`observable-scalar-corpus-v7` corpus of physics- and standards-derived scalar
instrument projections, including 18 explicit unknown/confuser scenarios.
Atomizer's generated Bayesian model pins that corpus at build time. The active
NDJSON bridge supplies swept-spectrum and detected-power observations qualified
`synthetic-visual-projection`; it claims no USB emulation, firmware execution,
RF emission, generator, display, touch, or complex-I/Q capability. Its selected
profile is visible only as source status and capability state and is never copied
into measurement or classifier evidence. Atomizer admits the same measurement
and provenance boundaries used by every other driver, and a bridge failure never
falls back to a TinySA or the Firmware twin. SignalLab has no runtime stimulus
connection to the twin. That separate future edge is a versioned
`SignalLabStimulusIntent -> Firmware stimulus sink`; Firmware must own the sink,
and activation requires a coordinated trio-contract revision.

## Atom

Place `OPENAI_KEY` in `.env`. The key is read only by the trusted Electron main process and never crosses preload into the renderer.

Both AI paths use exactly `gpt-realtime-2.1`:

| Path | Transport | Modalities |
|---|---|---|
| Voice | Realtime API over WebRTC | Audio, image context, function tools |
| Text | Realtime API over trusted WebSocket | Text, image context, function tools |

Both response paths use the identical closed registry of 50 concrete tools, `reasoning.effort: high`, and no model/API/transport fallback. The persistent session contains only `load_atom_tools`; Atom selects at most eight exact names for one operation, and the next `response.create` installs only those concrete schemas. Voice uses Ballad, server VAD threshold `0.97`, and the separate `gpt-realtime-whisper` input-transcription subsystem; Chromium requests echo cancellation, noise suppression, and automatic gain control.

Realtime tool calls are executed only from completed `response.done` items. Atomizer submits every function output, then exactly one continuation response with the current response-scoped schemas, so a tool cannot race the response that requested it. User and assistant transcript deltas stream into the Atom history. Voice makes one startup connection attempt with the microphone muted; microphone and Atom speaker state are independent, color-coded local human controls. `response.done.usage` and `rate_limits.updated` drive console and rail telemetry.

Every sent Realtime session setting is recursively compared with the API’s `session.updated` echo. Sent values, returned values, mismatches, and server-only defaults are emitted to the console. A mismatch or acknowledgement timeout terminates the session.

WebRTC admission sends only the immutable exact-model bootstrap with SDP. Atom then sends the voice, reasoning, transcription, concise instruction, and compact loader configuration over the data channel and keeps the microphone disabled until the API echoes it exactly. Text configures the same static loader contract once rather than rewriting instructions or injecting mutable application state every turn. Atomizer sets no output-token cap or reduced context/truncation window; throughput comes from response-scoped schema loading, not artificial token limits.

Atom’s AI surface is contract version 9; it executes against Atomizer application contract version 6:

- Every declared UI hook resolves to exactly one preferred typed tool, risk class, evidence projection, executor, and guarantee.
- The same validator, policy table, action-time approval, and executor serve voice and text.
- Every tool’s delivered parameters are generated from its execution-time Zod validator; Realtime-forbidden top-level schema combinators are absent, while cross-field invariants remain runtime-enforced and explicitly described.
- Coordinate computer actions consume a short-lived one-use screenshot ID; typing and keys require the exact focused-target identity returned by the latest screenshot or successful computer action.
- App screenshots are treated as untrusted image data.
- Coordinate actions are confined to the Atomizer window and fail closed on high-impact DOM targets.
- RF-output enable and general firmware-screen touch require immediate human approval.
- Firmware installation has no Atomizer tool or UI executor; the standalone `TinySA_Flasher` owns that physical workflow.
- Tool loops are bounded to eight operations.
- Unknown tools and malformed arguments return explicit failed tool evidence for one bounded schema-grounded correction. Missing evidence, duplicate Realtime calls, unavailable conversations, and session-protocol failure stop visibly without retry or reroute.

## Implemented instrument surface

- Exact ZS407 USB-shell framing and serialized command scheduling.
- Versioned `AtomizerInstrumentApiV1`, a static driver registry, one serialized instrument session, strict capability/configuration/measurement validation, SignalLab factory default, and no source fallback.
- Selectable physical ZS407 and executable-twin candidates through the `tinysa-zs407` driver, with qualified shipped/OEM provenance and warning-only custom-firmware admission.
- Analyzer configuration, readback, single/continuous spectrum acquisition, live pause-verify-resume retuning, raw/text transfers, and zero span.
- Device-observed `scanraw` offset readback and provenance-preserving Q5 decoding.
- Spectrum, coherent waterfall, channel power/PSD/ACP/ACLR/OBW, and detected-envelope STFT.
- Four host traces (`H1..H4`): Clear/Write, Max Hold, Min Hold, linear-power Average, View, explicit Off, and reset; enabled firmware traces are separately read as provenance-bearing `D1..D4` frames and overlaid only when explicitly enabled.
- Eight markers, all off by default: independently off/on, fixed/peak tracking, trace assignment, peak/min/next search, delta, and dBm/Hz.
- Explicit reference level, dB/div, and evidence-backed auto scale.
- Experimental multiscale Bayesian signal-presence evidence over scalar power,
  with a multiplicity-adjusted predictive null check, conservative exponential
  baseline, explicit model/prior evidence, a two-state cross-sweep filter, and
  candidate/active/released states. No physical false-alarm rate is yet claimed.
  Detect alone overlays active bandwidth
  regions and dashed channel-center lines; Spectrum remains annotation-free.
- Experimental Bayesian observable classification over 12 leaves, including a
  fitted background/unknown class and view-matched class-conditional inductive
  synthetic support rejection, from repeated scalar sweeps and optional qualified
  detected-power zero span.
  Outputs are evidence-equivalence classes such as CW-like, AM-like,
  FM/angle-like, GSM-like, Wi-Fi-like, Bluetooth-like, and LTE/NR
  cellular-OFDM ambiguous—not protocol identities or physically calibrated
  probabilities.
- Classify presents live-observation names, retains ranked unknown probability
  and content-addressed model/corpus provenance, binds features to the
  detector-frozen first-admission region and source sweeps, excludes
  unqualified physical cadence features, and never reads selected SignalLab
  state. A provisional frequency-agile 2.4 GHz association retains its broad
  band and source sweeps as separate provenance; it never overwrites the frozen
  emission region. A separate regular-spectral-component association records
  repeated same-sweep comb activity for classification without merging or
  promoting its independently expiring local tracks. The UI computes one group
  result per association while retaining every member's local provenance.
  Classification does not impose a second 3 dB active-bin admission gate.
- Generator frequency, level, path, AM/FM configuration, forced-off apply, RF state, and governed enable.
- Exact 480×320 RGB565 screen capture, diagnostics, and governed touch.
- Provenance-preserving CSV/JSON export.
- Sandboxed Electron renderer, allow-listed preload IPC, app-scoped computer harness, and exact-model Atom gateway.
- Firmware identity and custom-firmware provenance remain visible, but installation is deliberately absent and delegated exclusively to the standalone `TinySA_Flasher`.

## Safety and evidence boundary

Generator configuration and physical output do not have dependable firmware readback. They remain labeled `commanded`; uncertain transport loss makes RF state `unknown`. Software is not a hardware interlock.

The delivered physical ZS407 has passed initial receive-only text/raw sweep, diagnostics, exact LCD-byte validation, and one guarded update to the pinned `c979386` OEM firmware with post-reboot identity verification. It was subsequently observed running custom revision `43eb0f1`, which Atomizer admitted with exact USB/command/output-off checks and explicit `custom-unqualified` provenance. This is not RF calibration or complete Gate B qualification; timing matrices, destructive update-fault cases, cable-loss cases, touch, high-frequency behavior, generator behavior, and metrology remain open. See [the characterization record](./docs/PHYSICAL_ZS407_CHARACTERIZATION.md).

Zero span is detected power versus time, not I/Q. Envelope STFT and Bayesian
observable classification cannot establish phase, EVM, symbols, coding, or
protocol identity. The current 450-point/50 ms physical zero-span request is
`wall-clock-derived`, not timing calibrated, so cadence-rate features are
excluded. Standards-derived SignalLab scenarios are scalar instrument
projections, not conformance waveforms.

The 28-feature, 12-leaf `bayesian-observable-equivalence-v5` classifier uses
`scalar-observable-features-v5`, `engineering-design-class-weights-v1`,
`synthetic-view-matched-stratified-attempt-min-support-rank-detector-conditioned-physical-uncalibrated-v7`,
`runtime-domain-qualified-known-representatives-v3`, and
`observable-open-set-decision-v9`. Its content-addressed asset SHA-256 is
`05ec69aacc100f272446b7e00ba36cd112e516b8832585174312bac1f6af7d0c`:
18 Student-t components fitted from 8,140 detector-conditioned, fit-eligible
first-ready production representatives, with 1,990 stratified synthetic
acquisition-attempt minimum-reference scores per evidence view. The resulting
support rank is an engineering cutoff input, not a p-value or an exchangeable-
sample coverage guarantee. Its pinned 35-scenario SignalLab corpus
is `observable-scalar-corpus-v7` at commit
`03197cb5b4a03b85ef5efe6525f4f28ceedcaef3` and source SHA-256
`d813b3268eee7240a86b2de725ec78080dc0f3ce829fe0c493bf582b62f8529e`.
Fitting, calibration, and regression all use the production multiscale Bayesian
detector and two-state tracker, not an oracle or max-hold presence extractor.
Each example offers 24 sequential observations, or 96 for full-band 2.4 GHz
activity, and classification uses exactly the latest eight admitted local or
association sweeps. SignalLab applies TDMA/TDD/CSMA traffic at each swept bin's
actual visit time. Its AM and FM zero-span projections coherently sum the
resolved components through the configured Gaussian RBW response at the actual
tune frequency; they are receiver-filtered detected-power captures, not ideal
baseband envelopes.

Cellular structural eligibility uses
`standards-operating-band-context-v1`, which pins TS 45.005 19.0.0,
TS 36.101 18.5.0, and TS 38.104 18.12.0 operating-band tables. It requires the
complete observed interval to fit a listed link range with a bounded RBW edge
tolerance and retains every compatible FDD, TDD, SDL, or SUL mode in an
overlap. This context is a model-support mask, not protocol, deployment,
survey-prior, or regulatory-authorization evidence; SDL/SUL alone cannot
create an FDD/TDD result.

The tracker exposes two explicitly non-identifying classification associations.
`frequency-agile-2g4-activity-v3` records every eligible full-band opportunity,
including none and ambiguous looks, and pairs it with
`bayesian-frequency-agile-transition-v3` dynamics evidence over at most 96
opportunities. The agile side is an equal mixture of the neutral
`fullBand79CellChangePrior = Beta(78,1)` and
`threePrimaryChannelChangePrior = Beta(2,1)` engineering transition families;
neither is a Classic/LE protocol or emitter likelihood. The stationary side
uses a predeclared fixed change probability of 0.05; its exact sequential
false-promotion upper bound is
`1.3657385209e-5` through 96 positive looks under that independent stationary
null, before the additional three-resolution-cell guard. This is a model-bound
calculation, not a physical or merged-emitter false-association guarantee. It
can accumulate separated narrow 2.4 GHz activity, but may merge unrelated
emitters or leave activity fragmented and does not recover a
link, hop sequence, advertising event, or emitter identity. The
`simultaneous-regular-components-v1` comb association accepts at least three
repeated same-sweep regular components, abstains when competing/irregular
membership is ambiguous, expires independently of its local tracks, and never
creates a detection. A fixed-frequency tinySA zero-span capture sees only the
tuned Bluetooth channel. The 96-opportunity full-band horizon gives sparse
Bluetooth activity a defined acquisition window. On the final held-out
event-phase seeds, BLE acquired at one or more tested RBWs for 5/8 seeds at
24 dB and 8/8 at 32 dB; all 32 admitted BLE representatives resolved only to
Bluetooth-like band activity. The Wi-Fi template leaves are likewise diagnostic:
the primary Wi-Fi result is only `802.11-compatible channel morphology · PHY
unresolved`, never an 802.11 protocol or PHY identity.

## Release gates

Repository-local verification:

```bash
npm run check
npm --prefix ../TinySA_SignalLab run check
```

Cross-repository contract and executable-twin verification:

```bash
npm run check:trio-contract
npm run train:signal-classifier
npm run check:signal-classifier-model
npm run check:signal-classifier
npm run check:signal-classifier-publication
npm run check:bayesian-detector
npm run check:firmware-twin
npm run release:trio
```

`check:trio-contract` requires byte-identical v4 manifests and reconciles
Atomizer, Firmware bridge, SignalLab, and external Flasher ownership/contract
versions. TinySA_Flasher's active interface catalog v3 retains the active
application contract v2 (`deviceContractVersion: 2`); interface catalog v2 and
legacy application contract v1 are frozen. The trio does not pin an
independently versioned Flasher firmware release.
`train:signal-classifier` reproducibly regenerates the content-addressed model
asset. `check:signal-classifier-model` reruns that deterministic training and
requires the checked-in model and hash manifest to be byte-identical before a
trio release can pass. `check:signal-classifier` runs the pinned
production detector/tracker, exact eight-admission feature window, pinned
synthetic-support views, measured-interval eligibility masks, and decision
policy over the SignalLab regression matrix. It keeps fitted unknowns, strict
unknown holdouts, declared ambiguity stress cases, exact scalar-equivalence
nulls, and the acquisition-limited one-timeslot GSM scenario as separate audit
partitions. Exact-equivalence and ambiguity cases must accept only their
declared compatible evidence classes; they are not forced into a
scientifically false unique identity. These are observational-equivalence and
development-regression checks, not untouched physical validation, emitter
identification, or protocol validation. The final eight-seed,
three-interstitial-RBW regression
ran 4,200 acquisition attempts and classified 9,944 first-ready
representatives: hierarchical accuracy was 0.985318, known coverage 0.993796,
covered-known hierarchical accuracy 1.0, fitted-unknown and strict-holdout
rejection 1.0, and there were zero disallowed false-accept attempts. All 840
exact-equivalence nuisance cells, 2,278 representative pairs, and 4,556
evidence-view pairs matched within `1e-11` with zero discrepancies.
`check:signal-classifier-publication` is the read-only publication gate run
immediately after that validator. It requires the generated report, checked-in
model bytes, hash manifest, README, and normative classifier documents to agree
on the model SHA-256 and every published rounded validation figure; stale prose
fails with the expected replacement text.
`check:bayesian-detector` runs a 64,000-null-sweep default simultaneous-family
design across eight stationary Gamma/correlation configurations, production
signal-Pd gates, exact common-scale gain invariance, and separately labeled
out-of-model stress diagnostics. The final run observed zero nominal-null
detections (simultaneous 95% upper bound 0.000933724 against the 0.001 target)
and passed all 56,000 signal trials, paired-monotonicity gates, and common-scale
gain checks; it is not receiver calibration.
`check:firmware-twin` boots Renode, checks
the exact ready declaration, runs a real firmware sweep, captures the LCD, and
verifies generator output returns off.

## Workspace map

- `apps/desktop`: Electron main/preload, React operator UI, Atom host, and app computer harness.
- `packages/contracts`: runtime-validated instrument, device, transport, measurement, safety, and `AtomizerInstrumentApiV1` types.
- `packages/tinysa`: generic driver registry/manager plus the SignalLab and `tinysa-zs407` drivers; the latter contains physical serial, executable-twin, parser, scheduler, and device-service details.
- `packages/test-device`: deterministic protocol test double used only by tests.
- `packages/analysis`: traces, markers, detection, metrics, channel analysis, morphology, and envelope STFT.
- `packages/agent`: exact Realtime configuration, closed tool/control topology, schemas, policies, approvals, and session verification.
- `contracts`: cross-repository composition manifest.

## macOS live development app

```bash
npm run dev:install-app
```

This installs `~/Applications/TinySA Atomizer Dev.app`, binds it to this checkout, adds the icon to the Dock, and launches the live development app. Renderer edits use HMR. Quit and reopen after main, preload, or shared-package changes. Launcher logs and recovery steps are in [tools/dev-launcher/README.md](./tools/dev-launcher/README.md).

## Normative contracts

- [Trio composition](./contracts/trio-composition-v4.json)
- [Atom AI, Realtime, tools, and computer use](./docs/AI_NATIVE_CONTRACTS.md)
- [Firmware protocol](./docs/FIRMWARE_PROTOCOL_CONTRACT.md)
- [Physical ZS407 characterization](./docs/PHYSICAL_ZS407_CHARACTERIZATION.md)
- [Historical firmware-update contract and standalone ownership handoff](./docs/FIRMWARE_UPDATE_CONTRACT.md)
- [Markers, traces, display, and trigger](./docs/MEASUREMENT_CONTROLS_CONTRACT.md)
- [Waterfall, channel measurements, OBW/ACP, and envelope STFT](./docs/ADVANCED_MEASUREMENTS_CONTRACT.md)
- [Bayesian detection and classification research basis](./docs/BAYESIAN_DETECTION_CLASSIFICATION_RESEARCH.md)
- [Bayesian observable-class contract](./docs/SIGNALLAB_EMSO_CLASSIFIER_CONTRACT.md)
- [UI and UX](./docs/UI_UX_CONTRACTS.md)
- [Master work-package contract](./CONTRACTS.md)
- [Delivery and hardware-qualification plan](./PLAN.md)
