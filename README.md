# TinySA Atomizer

TinySA Atomizer is an AI-native Electron instrument host. It owns operator intent, instrument selection and lifecycle, measurement projections, and Atom—the application-layer voice and tool-using RF agent. Its current drivers compose SignalLab and the tinySA Ultra+ ZS407 without flattening synthetic measurements, physical USB, or executable firmware into the same evidence class.

The live system is deliberately split into four independently versioned repositories:

| Repository | Sole owner | Current edge |
|---|---|---|
| `TinySA` | Operator app, instrument host, normal CDC analyzer/generator sessions outside firmware-update sessions, measurement analysis, Atom policy and approvals | Hosts the active SignalLab and `tinysa-zs407` drivers |
| `TinySA_Firmware` | Pinned executable Renode twin and bridge | Selectable through the `tinysa-zs407` driver |
| `TinySA_SignalLab` | High-level synthetic measurement producer, scalar-classification corpus, visual waveform descriptors, seeded channel models, stimulus intent | Active versioned NDJSON measurement edge to Atomizer; Firmware stimulus sink remains reserved |
| `TinySA_Flasher` | Standalone physical firmware discovery, preflight, DFU, write journaling, and recovery | Active interface catalog v3 retaining active application contract v2 (`deviceContractVersion: 2`); interface catalog v2 and legacy application contract v1 frozen; no Atomizer runtime edge |

The normative Atomizer/Firmware/SignalLab runtime composition is byte-identical in those three repositories at [trio-composition-v4.json](./contracts/trio-composition-v4.json). Physical USB, the Renode monitor bridge, and SignalLab simulation are never represented as the same transport or evidence class. Firmware installation is outside that runtime graph and belongs exclusively to the standalone sibling application at `../TinySA_Flasher`; Atomizer does not download firmware, enter DFU, or expose a flash API.

USB ownership is session-scoped: Atomizer owns CDC analyzer/generator operation, while TinySA Flasher owns CDC discovery and preflight, DFU admission and write, and CDC post-write verification for the complete firmware-update session. The two applications must never access the same physical device simultaneously. Atomizer requests the operating system's exclusive native serial lock (`lock: true`) for every admitted CDC open, so a second native owner must fail rather than share bytes. Disconnect or close Atomizer before opening a Flasher update session, and finish or safely exit that session before reconnecting Atomizer.

Composition v4 has no cross-application handoff protocol or durable shared lease. The native lock is the current enforcement boundary and the explicit local-human disconnect is the current handoff; Flasher's write mutex governs updater processes, not an active Atomizer CDC session. Adding automatic coordinated handoff would require a newly versioned Atomizer↔Flasher edge and matching changes in both applications. Neither app may infer ownership merely because a port disappeared or a DFU endpoint appeared.

For owner-built firmware, TinySA Flasher's native manifest picker starts in the
sibling `../TinySA_Firmware` checkout when that directory exists. It remembers a
different picker directory only after the selected manifest passes Flasher's
normal admission. That convenience grants no authority to the source checkout,
does not attest an image, and creates no Atomizer runtime dependency or edge.

## Run

Requirements:

- Node.js 22.23.1 (pinned by `.node-version` and CI) and npm 10.9.8 (pinned by
  the package contract and CI).
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
2. Load the owner-only version-1 preference. Every new write persists the exact `{driverId,candidateKind,candidateId}` tuple. With no preference file, select the exact canonical `signal-lab:default` candidate as the explicit factory default; legacy v1 broad records remain readable but fail on ambiguity.
3. Match the persisted exact tuple, or the unique candidate allowed by a legacy broad record. A stale exact candidate ID, no match, or ambiguity fails visibly and never selects another candidate.
4. Connect only that candidate. Discovery, bridge, identity, malformed-firmware, required-command, or twin boot/evidence failure is terminal for the admission attempt and never falls through to another source.
5. An operator may explicitly make SignalLab, a physical ZS407, or the executable twin the new default after the active session is safely disconnected. A syntactically valid unknown physical revision is admitted only as `custom-unqualified`, with persistent warning and no invented source provenance.

The executable twin boots the pinned `lab-v0.2.0-protocol` firmware in Renode. Its sweeps, LCD framebuffer, touch behavior, and generator state come from executable firmware. Its transport is `renode-monitor-bridge`; USB transactions are explicitly not modeled.

The byte-level test device in `packages/test-device` is test-only. It is not a runtime fallback.

The transport-neutral, contract-aware driver lifecycle is owned by
`@tinysa/instrument-runtime`: driver/session interfaces, the static registry,
the serialized manager, and measurement fingerprinting depend only on the
runtime contracts and validation library. The runtime imports no source
adapter, but it enforces the contracts' current closed source/provenance and
SignalLab feature variants. `@tinysa/signal-lab-driver` depends only on that
runtime and `@tinysa/contracts`; it owns the SignalLab adapter and bridge client
without a TinySA or `serialport` dependency. `@tinysa/device` owns only the
`tinysa-zs407` adapter plus TinySA-specific serial, Renode, parser, scheduler,
and device-service code. It does not re-export generic lifecycle ownership or
retain compatibility aliases. Host and driver code imports the runtime
directly, while each source adapter remains in its own package so a later
producer can evolve without inheriting another source's transport assumptions.

## SignalLab

SignalLab is a separate application and Git repository. Atomizer builds and launches its version-1 high-level measurement bridge for the `signal-lab` driver:

```bash
npm --prefix ../TinySA_SignalLab install
npm --prefix ../TinySA_SignalLab run build:bridge
npm --prefix ../TinySA_SignalLab run dev
```

`npm run package:mac` first rebuilds that bridge, builds Atomizer, and stages a
self-contained `signal-lab` Electron resource root containing the active v1
contract, all nine generator-hashed JavaScript artifacts, its ESM package
boundary, and SignalLab's exact pinned Zod runtime. Electron Builder copies that
root to `process.resourcesPath/signal-lab`, which is the only packaged location
the factory-default driver admits. The pre-signing `afterPack` hook re-hashes
the actual `.app` copy, rejects extra/missing/symlinked files, and normalizes the
bridge executable mode. `npm run check:packaged-resources` verifies
the layout, executable mode, dependency resolution, path-indirection rejection,
and packaging configuration without producing a release artifact.

It owns a 34-profile closed catalog: 12 public canonized scalar-observable
profiles share the classifier's executable known-scenario source, while 22
remaining visual/standards stimulus profiles stay outside classifier truth. It
also owns deterministic AWGN/Rayleigh channel configuration, and the separate
immutable 35-scenario `observable-scalar-corpus-v13` corpus of physics- and
standards-derived scalar instrument projections, including 18 explicit
unknown/confuser scenarios.
The selectable catalog excludes named test models when SignalLab does not
reproduce their required power-balanced allocation, per-slot PRB sequence,
subslot/slot timing, or SBFD spectral partition; a disclosure alone does not
make an unimplemented standard model selectable.
Atomizer's generated Bayesian model pins that corpus at build time. The active
NDJSON bridge supplies swept-spectrum and detected-power observations qualified
`synthetic-visual-projection`; it claims no USB emulation, firmware execution,
RF emission, generator, display, touch, or complex-I/Q capability. Its selected
profile is visible only as source status and capability state and is never copied
into measurement or classifier evidence. Detected-power requests carry one
required safe-integer center frequency; SignalLab returns that exact tune and
receiver-filters its source model there. Atomizer admits the same measurement
and provenance boundaries used by every other driver, and a bridge failure never
falls back to a TinySA or the Firmware twin. SignalLab has no runtime stimulus
connection to the twin. That separate future edge is a versioned
`SignalLabStimulusIntent -> Firmware stimulus sink`; Firmware must own the sink,
and activation requires a coordinated trio-contract revision.

## Atom

On POSIX, place `OPENAI_KEY` in a local `.env`, then restrict it before starting
the development app:

```bash
chmod 600 .env
```

The trusted Electron main process opens `.env` with `O_NOFOLLOW`, validates
regular-file type, current-user ownership, and owner-only mode on that same file
descriptor, rejects files larger than 65,536 bytes before reading, reads from
the descriptor, and rejects metadata or content-state change during admission.
The launcher performs its own metadata-and-size preflight only as defense in
depth; direct `npm run dev` uses the same main-process loader. On platforms
without secure no-follow file opens, Atomizer refuses `.env` files and requires
`OPENAI_KEY` in the inherited process environment. The key never crosses
preload into the renderer.

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
- Multiple legal tool calls in one Realtime response execute sequentially against one synchronous controller snapshot: each domain commit updates its controller ref before its React projection, and DOM inspection/computer calls wait on a bounded fail-closed render-commit barrier.
- Coordinate computer actions consume a short-lived one-use screenshot ID bound to the exact normalized application bitmap; click/scroll recapture and compare that bitmap before dispatch. Typing and keys consume a short-lived rotating focus grant issued only by the latest screenshot or successful focus-producing click/type/key action, then revalidate that exact target at native input delivery.
- App screenshots are treated as untrusted image data.
- Coordinate actions are confined to the Atomizer window and fail closed on high-impact DOM targets.
- RF-output enable and general firmware-screen touch require immediate human approval.
- Firmware installation has no Atomizer tool or UI executor; the standalone `TinySA_Flasher` owns that physical workflow.
- Tool loops are bounded to eight operations.
- Unknown tools and malformed arguments return explicit failed tool evidence for one bounded schema-grounded correction. Missing evidence, duplicate Realtime calls, unavailable conversations, and session-protocol failure stop visibly without retry or reroute.

## Implemented instrument surface

- Exact ZS407 USB-shell framing and serialized command scheduling.
- Versioned `AtomizerInstrumentApiV1`, a static driver registry, one serialized instrument session, strict capability/configuration/measurement validation, exact `signal-lab:default` factory default, and no source fallback.
- Selectable physical ZS407 and executable-twin candidates through the `tinysa-zs407` driver, with qualified shipped/OEM provenance and warning-only custom-firmware admission.
- Analyzer configuration, readback, single/continuous spectrum acquisition, live pause-verify-resume retuning, raw/text transfers, and zero span.
- Device-observed `scanraw` offset readback and provenance-preserving Q5 decoding.
- One sidebar group contains exactly Spectrum, Waterfall, Channel, Detect, Generate, and Device. Channel provides power/PSD/ACP/ACLR/OBW, Spectrum has no second top view-tab bar, and detected-envelope STFT remains a typed non-rendered analysis/Agent capability.
- The spectrum trace is a live React projection of the current validated sweep and trace state. SVG is only the in-DOM drawing primitive for the current polylines, grid, marker stems, and brackets; it is not a static image or pre-rendered chart asset.
- Four host traces (`H1..H4`): Clear/Write, Max Hold, Min Hold, linear-power Average, View, explicit Off, and reset; enabled firmware traces are separately read as provenance-bearing `D1..D4` frames and overlaid only when explicitly enabled.
- Eight markers, all off by default: independently off/on, fixed/peak tracking, trace assignment, peak/min/next search, delta, and dBm/Hz. Narrow or resolution-limited responses stay on the sampled peak and expose local 3 dB width only when both crossings are bounded; otherwise width is unavailable. A qualified bounded broad component instead centers on its noise-subtracted power centroid and reports a separate component-local 99% OBW.
- Explicit reference level, dB/div, and evidence-backed auto scale.
- Experimental multiscale Bayesian signal-presence evidence over scalar power,
  with a multiplicity-adjusted predictive null check, conservative exponential
  baseline, explicit model/prior evidence, a two-state cross-sweep filter, and
  candidate/active/released states. No physical false-alarm rate is yet claimed.
  The merged Detect workspace overlays active bandwidth regions and
  dashed channel-center lines; Spectrum remains annotation-free. Detect's Auto
  control selects the strongest eligible physical peak from the complete exact
  sweep currently drawn. It never substitutes a weaker history-ready row when
  that strongest visible target lacks a capture-ready evidence window; capture
  fails visibly instead.
- Experimental Bayesian observable classification over 12 leaves, including a
  fitted background/unknown class and view-matched class-conditional inductive
  synthetic support rejection, from repeated scalar sweeps and optional qualified
  detected-power zero span. A continuous-valued detector centroid is projected
  once to the nearest advertised integer-Hz detected-power tune (higher on an
  exact tie); non-finite or out-of-range tunes are rejected, and the projected
  value is retained in both the request and capture provenance. Selecting a
  classification candidate stages that projected tune before capture.
  Outputs are evidence-equivalence classes such as CW-like, AM-like,
  FM/angle-like, GSM-like, Wi-Fi-like, Bluetooth-like, and LTE/NR
  cellular-OFDM ambiguous—not protocol identities or physically calibrated
  probabilities.
- Detect presents live-observation names, retains ranked unknown
  probability and content-addressed model/corpus provenance, binds features to the
  detector-frozen first-admission region and source sweeps, excludes
  unqualified physical cadence features, and never reads selected SignalLab
  state. A provisional frequency-agile 2.4 GHz association retains its broad
  band and source sweeps as separate provenance; it never overwrites the frozen
  emission region. A separate regular-spectral-component association records
  repeated same-sweep comb activity for classification without merging or
  promoting its independently expiring local tracks. A third
  `multicomponent-swept-region-v2` association can retain a changing run of four
  or more independently Bayesian-admitted local components as non-identifying
  regional history. The UI computes one group result per association while
  retaining every member's local provenance.
  Classification does not impose a second 3 dB active-bin admission gate.
- Generator frequency, level, path, AM/FM configuration, forced-off apply, RF state, and governed enable.
- Exact 480×320 RGB565 screen capture, diagnostics, and governed touch.
- Provenance-preserving CSV/JSON export.
- Sandboxed Electron renderer, allow-listed preload IPC, app-scoped computer harness, and exact-model Atom gateway.
- Firmware identity and custom-firmware provenance remain visible, but installation is deliberately absent and delegated exclusively to the standalone `TinySA_Flasher`.

## Safety and evidence boundary

Generator configuration and physical output do not have dependable firmware readback. They remain labeled `commanded`; uncertain transport loss makes RF state `unknown`. Software is not a hardware interlock.

The delivered physical ZS407 has passed initial receive-only text/raw sweep, diagnostics, exact LCD-byte validation, and one guarded update to the pinned `c979386` OEM firmware with post-reboot identity verification. It was subsequently observed running custom revision `43eb0f1`, which Atomizer admitted with exact USB/command/output-off checks and explicit `custom-unqualified` provenance. This is not RF calibration or complete Gate B qualification; timing matrices, destructive update-fault cases, cable-loss cases, touch, high-frequency behavior, generator behavior, and metrology remain open. See [the characterization record](./docs/PHYSICAL_ZS407_CHARACTERIZATION.md).

Zero span is detected power versus time, not I/Q. The non-rendered Envelope STFT analysis and Bayesian
observable classification cannot establish phase, EVM, symbols, coding, or
protocol identity. The current 450-point/50 ms physical zero-span request is
`wall-clock-derived`, not timing calibrated, so cadence-rate features are
excluded. Standards-derived SignalLab scenarios are scalar instrument
projections, not conformance waveforms.

Production inference does not use missing-dimension marginalization: v8 selects one exact evidence view, requires its complete finite feature set with no extras, and evaluates only the independently fitted spectrum-only, envelope-untimed, or envelope-timed likelihood population. Its likelihood architecture preserves equal source-scenario mass while decomposing exactly the five canonized `csma-bursts` sources into three deterministic activity modes with empirical within-source weights and one shared pooled covariance; the remaining sources retain one component.

The App issues a `DetectedPowerCaptureReceipt` for a manual zero-span action only
when the selected (or automatically selected) target is admitted on the exact
eight-sweep evidence window and the capture uses its exact projected tune. That
schema-3 receipt binds the capture to its detector-frozen representative and
uses domain-separated SHA-256 over canonical JSON to bind every returned
sample, cadence/geometry field, RF metadata field, source field, and provenance
field. Only that exact payload permits the matching ordinary local or
static-region result to enter the appropriate envelope view. For a
receipt-qualified capture, the analysis boundary rejects root or nested Proxy
graphs, retains a deeply frozen structured-clone snapshot, and computes
features only from that authority-owned snapshot to eliminate hash/read TOCTOU.
For a frequency-agile projection, the receipt and physical
capture remain acquisition audit evidence but the fixed-tune envelope is
censored and the exact regional spectrum/history view is classified. A manual
capture that cannot satisfy those provenance checks remains unqualified: its
Bayesian result stays spectrum-only, while the raw capture may still feed the
separate envelope heuristic.

The App zero-span action enters a Bayesian envelope view only when the capture is bound to an analysis-issued receipt for a current runtime-admitted target, exact admitted tune, and exact eight-sweep evidence window. Receipt qualification is necessary but not sufficient: under frequency-agile-fixed-tune-envelope-censoring-v1, every fixed-tune frequency-agile capture remains excluded from Bayesian envelope inference and the exact spectrum view is used instead. Any other receipt-free or runtime-unadmitted capture may feed only the separate envelope heuristic.

The 28-feature, 12-leaf `bayesian-observable-equivalence-v8` classifier uses
`scalar-observable-features-v7`, `engineering-design-class-weights-v1`,
`synthetic-independent-branch-view-matched-causal-acquisition-support-rank-detector-conditioned-physical-uncalibrated-v19`,
`observation-only-hypothesis-domain-v5`, and
`observable-open-set-decision-v10`. The independently regenerated v19 model
asset has SHA-256
`6e25efced19690b599745000fe6b0ea46ca1af67220bb3b2b3b691b9bcf2ffe4`.
Domain policy v5 lets the FM leaf participate only when the scalar observation
has `spectrum.sidebandScore >= 0.2`, or both `envelope.rangeDb >= 2` and
`envelope.standardDeviationDb >= 0.5`; an unresolved finite scalar view remains
CW-like or `unknown`. This is an evidence-resolution gate, not a universal FM
definition.
The checked-in v8 likelihood architecture has 28 ordered feature dimensions and 12 exact leaf class IDs. Its spectrum-only population has 18 source scenarios and 28 likelihood components; each envelope population has 16 scenarios and 26 components because the Bluetooth-like class is structurally unsupported for fixed-tune envelope evidence. Under scenario-components-with-three-shared-covariance-csma-activity-modes-v1, exactly five pinned CSMA sources use three deterministic activity modes while every other supported source/view pair uses one component; source scenarios retain equal within-class mass, CSMA modes use empirical within-source weights, and each decomposed source shares one pooled within-mode covariance. Under frequency-agile-fixed-tune-envelope-censoring-v1, the analysis boundary validates the physical capture and schema-3 receipt first, including its canonical SHA-256 binding of all returned samples, cadence, requested geometry, RF metadata, and provenance, then excludes detected-power envelope features for every frequency-agile association and classifies its exact regional spectrum/history view. This censor is triggered by observed association geometry, never a truth label or requested hypothesis; Bluetooth envelope component and calibration arrays are therefore exactly empty. The resulting
support rank is an engineering cutoff input, not a p-value or an exchangeable-
sample coverage guarantee. Its pinned 35-scenario SignalLab corpus is
`observable-scalar-corpus-v13` at commit
`03bc13eb9d5efcfc5f2f9c1792042f670b71ef9a`. The canonical JSON manifest
covering the executed TypeScript import closure (`src/canonical-timing.ts`,
`src/catalog.ts`, `src/classification-corpus.ts`, `src/contracts.ts`,
`src/source-provenance.ts`, and `src/waveforms.ts`) plus `package.json` and
`package-lock.json` dependency semantics has SHA-256
`38288f0e0437dbb687674308afecb4f30adadc9e93ea7abad3b8bf13d80ec918`.
The open-set rejection cutoff is a minimum maximum-known synthetic support rank of 0.025; it is an engineering threshold, not a p-value or coverage guarantee.
The trainer and independent validator require a clean SignalLab index/worktree,
prove that exact relative-import closure, and require every regular,
non-symlink, tracked file to byte-match its blob at that commit.
The completed v19 release evidence satisfies the acquisition contract below.
The fitted and independently regenerated acquisition matrix uses SignalLab's 450-point recommended-span grid in two independent production-gate sessions under independent-no-auto-spectrum-and-qualified-first-admitted-envelope-sessions-v1. The no-automatic-capture consecutive-spectrum branch starts its twelve profiles at source looks 0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, and 416 and spans source indices [0, 512); the qualified-envelope branch starts them at source looks 0, 33, 66, 99, 132, 165, 198, 231, 264, 297, 330, and 427 and spans [0, 524), with at most one detected-power capture after first runtime admission. Under preferred-then-strongest-current-physical-or-qualified-agile-member-target-v3, ordinary targets are active physical rows with zero missed sweeps. The only candidate-state exception is the exact latest raw detector/track member cited by the latest exactly-one opportunity of a current, promotion-qualified, zero-miss frequency-agile association. The synthetic activity summary never owns the hardware capture, and arbitrary candidates, stale members, retained summaries, and ambiguous opportunities remain ineligible. An autonomous branch ranks eligible raw rows by strongest current peak and uses the stable key and ID only as exact-power tie-breaks; association qualification controls only whether the narrow agile projection exists, never priority among eligible rows. Truth labels, class-domain eligibility, feature readiness, and classifier posteriors never influence that ranking. After raw ranking, the controller tunes and binds the capture to the raw row while receipt schema 3 projects the exact eight-sweep classifier window to its evidence representative and binds the complete returned capture with domain-separated canonical SHA-256. For an agile projection the receiver remains fixed on the selected physical channel and may observe later returns or no return; it never follows the hop and proves neither a common emitter nor Bluetooth protocol or mode identity. Under frequency-agile-fixed-tune-envelope-censoring-v1 the valid capture and receipt remain audited, but every frequency-agile fixed-tune envelope is excluded from classifier features and the exact regional spectrum/history view is used; this observation-geometry censor is independent of truth or requested hypothesis. Later spectra continue at the next source look. Held-out validation begins at source look 512 for consecutive spectrum and 524 for qualified envelope. Every envelope admitted to a classifier likelihood requires an analysis-issued capture receipt and is explicitly qualified as receipt-verified-provenance-bound-first-runtime-admitted-strongest-current-physical-or-agile-member-single-capture-v4; receipt-free or runtime-unadmitted captures cannot enter Bayesian envelope metrics. Public detected-power synthesis uses the generator-internal 100 kHz filter; measured detected-power RBW remains unavailable and is never classifier evidence.

The schema-3 receipt is minted only by the analysis boundary after independent replay and candidate ranking, is deeply frozen and process-authorized, and is revalidated against the representative, admitted tune, ordered eight-sweep window, and domain-separated SHA-256 of the complete canonical returned capture before envelope features are admitted. The digest binds every power sample, cadence and requested-geometry/control field, RF metadata/qualification, source field, and provenance field; an authorized receipt fails closed against any substituted finite capture.
Fitting, tail calibration, and held-out regression all use the production
multiscale Bayesian detector and two-state tracker, not an oracle or max-hold
presence extractor. Fitting, tail calibration, and held-out validation offer
32 sequential opportunities for standard geometry; full-band 2.4 GHz activity
uses 96 in all three. Classification uses exactly the
latest eight admitted local or association sweeps. At each swept bin's actual
visit time, SignalLab applies a
deterministic fixed-slot-0 one-of-eight GSM envelope, the fully selected LTE
TDD configuration, the standards-valid NR 7-DL/3-UL engineering schedule, and
a seeded CSMA-like Wi-Fi engineering envelope. These scalar acquisition
schedules are not decoded MAC traffic or protocol likelihoods. Its AM and FM
zero-span projections coherently sum the
resolved components through the explicit generator-internal 100 kHz synthesis
filter at the actual tune frequency; they are receiver-filtered detected-power
captures, not ideal baseband envelopes. That synthesis width is reproducibility
provenance, while measured detected-power RBW remains unavailable and never
enters classifier evidence.

Corpus v13 retains three scenario-local timing choices made explicit in v11. The Band 38 LTE
TDD projection uses `lte-tdd-config0-ssp7-normal-cp-downlink-v1`: downlink-only
UL/DL configuration 0 with special-subframe
configuration 7: `DSUUUDSUUU`, with each special subframe divided into
714.583333 microseconds DwPTS, 142.708333 microseconds guard period, and
142.708333 microseconds UpPTS; only DwPTS contributes downlink power, for exact
duty 0.3429166667. The n78 projection uses the valid engineering schedule
`nr-tdd-7dl-3ul-engineering-v1`, seven complete downlink then three complete
uplink slots in 5 ms at 30 kHz SCS, with no mixed/flexible symbols. Its exact
carrier center is 3,500,010,000 Hz, NREF 633334, on the selected n78 30 kHz
band-specific channel raster; this raster is not the 15 kHz global NR-ARFCN
step in that frequency range. The BLE
primary-advertising projection uses `ble-primary-advertising-engineering-v1`:
all three 2402/2426/2480 MHz primary centers in sequential 37-to-38-to-39 order,
1.5 ms packet-start spacing, 376 microsecond packets, and a deterministic seeded
per-event advertising delay in `[0,10 ms)`. That sequence is standards-consistent
for the modeled legacy all-three-channel event; configured subsets, early event
closure, and extended advertising differ. The all-three choice, spacing,
duration, interval, and deterministic delay generator are engineering choices,
not universal Bluetooth traffic or PDU behavior. Its 80 MHz field is the
aggregate primary-channel support span, not instantaneous occupied bandwidth.

Tracker hysteresis may keep a recently promoted association visible to an
operator after its current evidence falls below the classifier promotion gate.
That retained state returns insufficient evidence and is not an
observation-domain-eligible online calibration window; it is never relabeled as
a ready observation.

Tracker readiness is not by itself classifier admission. “First-ready” means
the earliest online opportunity whose complete cited sweeps replay as one
coherent, uniquely matched scalar evidence window. Runtime-unavailable evidence
returns `unknown` / `insufficient-evidence`; only declared retryable replay/ROI
cases may admit a later valid window during deterministic sampling. Missing
required provenance, duplicates, and contradictions still fail loudly.

Cellular structural eligibility uses
`standards-operating-band-context-v1`, which pins TS 45.005 19.0.0,
TS 36.101 18.5.0, and TS 38.104 18.12.0 operating-band tables. It requires the
complete observed interval to fit a listed link range with a bounded RBW edge
tolerance and retains every compatible FDD, TDD, SDL, or SUL mode in an
overlap. This context is a model-support mask, not protocol, deployment,
survey-prior, or regulatory-authorization evidence; SDL/SUL alone cannot
create an FDD/TDD result.

Those cellular tables and the 5/6 GHz Wi-Fi masks are standards-context
extrapolations beyond the corpus's fitted Band 3/Band 38/n3/n78 and 2.4 GHz
centers. They are hard structural exclusions, not evidence that likelihoods are
empirically fitted or physically validated throughout every admitted band.
Physical captures across those bands remain required before field claims.

The class weights are declared engineering assumptions, not estimates of field
prevalence. Deterministic unknown-mass and family-mass sensitivity gates bound
synthetic decision changes, coverage, and incompatible risk; representative
physical survey prevalence and prior calibration remain an open release
limitation.

The tracker exposes three explicitly non-identifying classification associations.
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
`regular-spectral-component-lineage-v2` comb association accepts at least three
same-sweep regular components, retains a stable allocated non-identity lineage
only while successive exact looks share one frequency lattice, overlapping
observed support, and at least one resolved component center, and publishes the
latest look's current members and hull.
Every retained look is independently replayed from its immutable source sweep.
It abstains when competing/irregular membership is ambiguous, expires
independently of its local tracks, and never creates a detection. A
fixed-frequency tinySA zero-span capture sees only the
tuned Bluetooth channel. The 96-opportunity full-band horizon gives sparse
Bluetooth activity a defined acquisition window. In the superseded pre-v19
held-out run, BLE acquired at one or more tested RBWs for 5/8 event-phase seeds
at 24 dB and 8/8 at 32 dB; all 32 admitted BLE representatives resolved only to
Bluetooth-like band activity. Those figures are historical development evidence,
not current release evidence; a fresh v19 report must replace them. The Wi-Fi template leaves are likewise diagnostic:
the primary Wi-Fi result is only `802.11-compatible channel morphology · PHY
unresolved`, never an 802.11 protocol or PHY identity.

`multicomponent-swept-region-v2` requires at least four independently admitted
local Bayesian detections. It is eligible either because a selected multiscale
classification region contains the current observed component hull within
RBW/bin tolerance, or because the resolved components satisfy its bounded
regular-raster rule. Its public region and membership are always the latest
current hull and current members, never a cumulative union. Lineage history is
limited to exact matching sweep geometry and regions whose padding by
`max(2 × RBW, 5 × bin width)` has intersection-over-union at least 0.75 and
shares at least one component center within that same tolerance. Incompatible
history is pruned and the lineage retains only the classifier's latest exact
eight looks. A lineage may reconnect only within the tracker release window;
missed evidence remains unqualified, and reacquisition after expiry receives a
new association ID. A zero-span capture remains evidence for its selected local
member and does not acquire regional time coverage. The association claims neither
simultaneity, a common generating process, nor emitter identity.

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
asset. Its ignored per-chunk cache is trusted-local crash-recovery and
developer acceleration only; it is not release evidence and must not be copied
between trust domains. The asset records the SHA-256 of the exact immutable
bundled sampling-worker closure used for both fitting and calibration.
Training runtime identity is also exact, not a semver range. The launcher reads
`.node-version` and rejects before any private build unless its own
`process.version` is exactly `v22.23.1`; the privately built trainer then
independently verifies the attested identity
`exact-repository-node-version-v1` / Node `22.23.1` / V8
`12.4.254.21-node.56`. The generated training matrix and validation acceptance
and report must carry that same identity. npm `10.9.8` remains a separate
developer/CI tooling pin, not part of the trainer runtime identity.
`check:signal-classifier-model` always starts an
independent fresh-sampling check, while allowing only an interrupted instance
of that same journaled check to resume. Once a fresh check completes, the next
invocation starts a new run. It requires the checked-in model and hash manifest
to be byte-identical before a trio release can pass. Each invocation compiles
the trainer/worker pair twice into a private temporary directory, requires the
two builds to be byte-identical, seals the selected pair read-only, and has the
executed trainer attest both bundle hashes before it can acquire the exclusive
run/publication lock. The trainer then pins that immutable worker bundle for
both fitting and calibration and uses a recovery journal for the two-file
model/manifest publication. The two renames are recoverable and runtime
content-identity checked; they are not claimed to be one filesystem-atomic
pair operation. The hash environment is a byte-consistency admission claim,
not cryptographic authentication against a same-user adversary; the local
checkout and installed toolchain remain trusted. These training/publication
commands fail closed on Windows
because Node's Windows mode APIs cannot prove the private bundles immutable;
use macOS or Linux until a Windows ACL- or handle-based admission path is
implemented. `check:signal-classifier` runs the pinned
production detector/tracker, exact eight-admission feature window, pinned
synthetic-support views, measured-interval eligibility masks, and decision
policy over the SignalLab regression matrix. It keeps fitted unknowns, the
strict unknown holdout, declared ambiguity stress cases, exact scalar-equivalence
nulls, and the acquisition-limited one-timeslot GSM scenario as separate audit
partitions. Exact-equivalence and ambiguity cases must accept only their
declared compatible evidence classes; they are not forced into a
scientifically false unique identity. These are observational-equivalence and
development-regression checks, not untouched physical validation, emitter
identification, or protocol validation. The following figures are retained from
the superseded pre-v19 development regression only; they are unavailable as
current release evidence until a fresh, independently regenerated v19 report
replaces them. That eight-seed, three-interstitial-RBW regression
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
The report's unkeyed `evidenceSha256` is a local integrity binding, not provenance authentication. Release trust comes from running the pinned clean-tree model rebuild and validator immediately before the publication gate; a copied or manually resealed report is not independent evidence.
`check:bayesian-detector` runs a 64,000-null-sweep default simultaneous-family
design across eight stationary Gamma/correlation configurations, one-look
production-settings local-candidate Pd gates, a separate exact two-look
production detector/tracker active-promotion matrix, common-scale gain
invariance, and separately labeled out-of-model stress diagnostics. The null
matrix uses the declared permissive high-candidate-load segmentation path; a
lower threshold can merge components, so it is not presented as a mathematical
superset of production segmentation. The last published regression observed
zero nominal-null detections (simultaneous 95% upper bound 0.000933724 against
the 0.001 target); its one-look branch completed 56,000 alternative trials and
passed its aggregate pointwise Pd and paired-monotonicity gates, while the
common-scale gain checks also passed. The two-look
matrix requires an active runtime track containing the declared center after
two ordered independent analytic looks; its pointwise lower gates are the
squares of the predeclared one-look gates. Neither Pd matrix has simultaneous-
family confidence. Both are conditional on the fixed detector prior and gain
mixture. The injected mean shift is an observation-domain detector alternative,
not a synthesized RF waveform, protocol, receiver calibration, sensitivity,
prevalence, or field-strength claim.
`check:firmware-twin` boots Renode, checks
the exact ready declaration, runs a real firmware sweep, captures the LCD, and
verifies generator output returns off.

## Workspace map

- `apps/desktop`: Electron main/preload, React operator UI, Atom host, and app computer harness.
- `packages/contracts`: runtime-validated instrument, device, transport, measurement, safety, and `AtomizerInstrumentApiV1` types.
- `packages/instrument-runtime`: transport-neutral, contract-aware driver/session interfaces, registry, serialized manager, and measurement fingerprinting; it imports no adapter and has no TinySA or serial-port dependency, while enforcing the contracts' closed source/provenance and SignalLab feature variants.
- `packages/signal-lab-driver`: independent SignalLab adapter and bridge client (`@tinysa/signal-lab-driver`); depends only on contracts and the transport-neutral runtime, never `serialport`.
- `packages/tinysa`: `tinysa-zs407` adapter plus TinySA-specific physical serial, executable-twin, parser, scheduler, and device-service details (`@tinysa/device`).
- `packages/test-device`: deterministic protocol test double used only by tests.
- `packages/analysis`: traces, markers, detection, metrics, channel analysis, morphology, and envelope STFT.
- `packages/agent`: exact Realtime configuration, closed tool/control topology, schemas, policies, approvals, and session verification.
- `contracts`: cross-repository composition manifest.

NeptuneSDR is not implemented or registered. The transport-neutral runtime
removes the TinySA dependency from its future driver lifecycle; it does not make
source registration open-ended. First-class support still requires a distinct
source/provenance variant, renderer and export paths
that do not assume scalar/TinySA-shaped staging, and a versioned complex-I/Q
streaming contract with chunking, backpressure, cancellation, and bounded
retention. A complete single-buffer I/Q shape alone is not streaming support.

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
