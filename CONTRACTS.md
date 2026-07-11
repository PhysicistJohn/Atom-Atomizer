# tinySA Desktop — Master Statement of Work and Work-Package Contracts

Status: active execution baseline, API v2, trio composition v2, 2026-07-11
Companion: [PLAN.md](./PLAN.md)

Trio authority: [contracts/trio-composition-v2.json](./contracts/trio-composition-v2.json)

Protocol authority: [docs/FIRMWARE_PROTOCOL_CONTRACT.md](./docs/FIRMWARE_PROTOCOL_CONTRACT.md)
Physical evidence: [docs/PHYSICAL_ZS407_CHARACTERIZATION.md](./docs/PHYSICAL_ZS407_CHARACTERIZATION.md)
Firmware update authority: [docs/FIRMWARE_UPDATE_CONTRACT.md](./docs/FIRMWARE_UPDATE_CONTRACT.md)
Measurement authority: [docs/MEASUREMENT_CONTROLS_CONTRACT.md](./docs/MEASUREMENT_CONTROLS_CONTRACT.md)
Advanced-measurement authority: [docs/ADVANCED_MEASUREMENTS_CONTRACT.md](./docs/ADVANCED_MEASUREMENTS_CONTRACT.md)
Stimulus authority: sibling `../TinySA_SignalLab/CONTRACTS.md` (current sink is reserved, not connected)
Experience authority: [docs/UI_UX_CONTRACTS.md](./docs/UI_UX_CONTRACTS.md)
Atom authority: [docs/AI_NATIVE_CONTRACTS.md](./docs/AI_NATIVE_CONTRACTS.md)

## 1. Master engagement

### Objective

Deliver a production-quality Electron desktop application that wholly operates one tinySA Ultra+ ZS407 over verified USB to the extent exposed by its installed firmware, or the explicitly labeled executable Firmware twin when no exact physical candidate exists. The product includes analyzer and generator control, measurement visualization, remote screen/touch, exports, governed Atom operation, automated tests, and operating documentation.

The host baseline is derived from sibling firmware commit `c97938697b6c7485e7cab50bca9af76996b7d671`. The delivered unit runs supported shipped revision `c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c`; its exact USB/identity/command evidence, receive-only text/raw sweeps, raw-offset variance, battery telemetry, and LCD byte shape are recorded. Remaining physical timing, fault, RF, touch, update, and metrology work stays explicitly unqualified.

### Contract form

Work is divided into independently assignable packages. A package is complete only when its deliverables, automated tests, acceptance evidence, and documentation are merged through its stated integration gate. Percentage-complete reporting is not accepted; status is `not started`, `active`, `in review`, `accepted`, or `blocked`.

Estimates are engineering ranges, not calendar promises. One engineering day (ED) is one focused contributor-day including package-local tests and documentation. Coordination, hardware shipping, certificate issuance, and store/vendor review are elapsed-time risks outside the ED totals.

### Baseline assumptions

- One genuine ZS407 is supplied for development and preferably a second for regression/recovery testing.
- Target platforms are current supported macOS, Windows 11, and one named Linux LTS distribution; final versions are frozen in WP-01.
- v1 is local-first, single-device, English-language, and has no account, cloud backend, telemetry, browser build, mobile build, or network control.
- Normal transport is USB CDC serial. Firmware update/DFU is permitted only through the separately governed content-addressed, human-confirmed update contract; raw/generic DFU remains excluded.
- TypeScript is used throughout application code. Electron hosts a sandboxed React renderer; serial access stays in the main process.
- Public protocol behavior may be implemented cleanly. GPL code is not copied or linked unless the owner explicitly chooses a compatible distribution license after legal review.
- Every application capability has an agent-hook disposition in the same package. The exact Atom model, transport, approval, and no-substitution rules are normative rather than optional integration work.

### Accepted implementation slice

The current repository has accepted automated evidence for API v2, exact prompt/parser/scheduler behavior, physical serial and Renode bridge boundaries, device service, analyzer text/raw/zero-span acquisition, diagnostics, screen/touch, generator safety sequencing, persistent detection, bounded classification, advanced scalar-sweep measurements, Electron v2, export serialization, Atom surface v4, the staged firmware updater, and five live workspaces. The initial physical receive-only slice is accepted as recorded evidence, not general RF-hardware qualification.

Default no-hardware execution is the sibling `TinySA_Firmware` Renode twin. It boots a pinned firmware binary, proves its release/source/hash/boot declaration, and yields firmware-executed sweeps, LCD state, touch, and generator state over `renode-monitor-bridge`. USB transactions are not modeled and USB identity is never claimed. One exact physical ZS407 suppresses the twin and is automatically admitted; multiple exact devices require selection; no exact device admits the twin. Discovery/identity/source/boot/evidence failure is visible and never activates another backend.

SignalLab is an independent repository and application. It owns 79 closed waveform descriptors, deterministic AWGN/Rayleigh channel configuration, and `SignalLabStimulusIntent`. Its Firmware sink is `reserved-not-connected`; Atomizer has no SignalLab tools or hidden process coupling. Activating that future edge requires a coordinated contract-version change in all three repositories.

Spectrum now exposes four host-derived trace slots and eight host-derived markers over complete acquired sweeps, plus trigger and amplitude-display controls. This mirrors established instrument workflows without claiming unreadable firmware state or equivalence to a vendor implementation. Exact mode semantics, evidence labels, and acceptance tests are governed by the measurement contract.

Work-package status is therefore interpreted as follows:

| Package group | Current status |
|---|---|
| WP-00, WP-02 through WP-10, WP-15, WP-16, WP-18 through WP-20 | Active vertical slice with automated evidence |
| WP-01, WP-13 | Initial physical receive-only phase accepted; full timing/fault/RF/update matrices active |
| WP-11, WP-12 | Partial: export/diagnostics implemented; durable sessions/support bundle remain |
| WP-17 | Hardware/data gated; no validated modulation or protocol classifier claim |
| WP-14, WP-21 | Release qualification pending |

### Firmware-update change-control addendum

The updater is an explicit expansion of WP-01 identity/provenance, WP-06 device lifecycle, WP-10 Electron integration, WP-13 hardware qualification, WP-14 release safety, and WP-20 Atom governance. Its only accepted target is the pinned OEM Ultra/Ultra+ binary declared in `packages/contracts` and `docs/FIRMWARE_UPDATE_CONTRACT.md`.

Artifact download and verification may occur automatically after an older supported physical revision is admitted. Self-test/configuration/RF-disconnection attestations, CDC teardown for DFU, and the final firmware write remain local human boundaries. The ZS407 self-test contract is exactly short 50 Ω coax from the SMA connector labeled `CAL` to the SMA connector labeled `RF`, then `CONFIG > SELF TEST`; generic LOW/HIGH wording is rejected. `dfu-util` version, STM32 DFU VID/PID, alternate, target name, candidate cardinality, artifact re-hash, durable pre-subprocess write-attempt evidence, and post-reboot identity are mandatory gates. Atom can observe, explain, download, and detect; every computer-input path rejects attest and flash boundaries. Started, completed, or indeterminate journal evidence forbids another write across process restarts.

### Global definition of done

All work packages WP-00 through WP-21 are accepted; the capability matrix has no unexplained rows; no open severity-1 or severity-2 defects remain; supported-platform clean-install and hardware tests pass; RF-output safety cases pass; installers and documentation are published; source, build instructions, dependency notices, SBOM, model/data provenance, agent/eval evidence, test evidence, and known limitations are delivered.

## 2. Common engineering contract

Every package must:

1. Work from versioned interfaces in `packages/contracts`; interface changes require an architecture decision record (ADR) and consumer review.
2. Include unit tests for its logic, integration tests at its boundary, fixtures without secrets or personal paths, and a short verification command.
3. Use structured errors and logs; never silently swallow protocol, parsing, storage, or IPC failures.
4. Fail visibly at the originating boundary. No package may silently substitute a model, API, transport, protocol command, data source, setting, or execution path, and no failed state-changing operation is retried automatically. Explicit user-selected simulation and explicit `unknown` safety state are not substitutes.
5. Preserve renderer sandboxing, context isolation, least-privilege IPC, strict input validation, and no remote content.
6. Avoid raw device commands outside the protocol adapter and raw Electron IPC outside main/preload adapters.
7. Document public types and user-visible limitations. Generated artifacts are reproducible and not hand-edited.
8. Pass formatting, lint, type-check, tests, dependency audit policy, and package-specific acceptance before review.
9. Provide an acceptance packet: commit identifier, commands run, results, screenshots or recordings where applicable, hardware/firmware identity, and deviations.

### Change control

- **Clarification:** no cost/scope change; recorded in the package notes.
- **Interface change:** ADR plus approval from every affected package owner.
- **Scope change:** written change request containing rationale, packages affected, estimate delta, risks, and acceptance changes.
- **Firmware variance:** captured as a versioned capability profile. It is not hidden with model-specific conditionals in the renderer.
- **Defect:** failure to meet accepted criteria. A new capability or platform is a change request, not a defect.

### Severity and release policy

- **S1:** unsafe RF-output behavior, data corruption, security boundary bypass, app/device unusable. Release blocker.
- **S2:** core connection/acquisition/control unavailable without reasonable workaround. Release blocker.
- **S3:** degraded secondary function with workaround. Must be triaged and documented.
- **S4:** cosmetic or minor documentation issue. May be deferred.

## 3. Authoritative interfaces

### Repository layout

```text
apps/desktop/             Electron main, preload, and React renderer
packages/contracts/       Pure serializable TypeScript contracts
packages/tinysa/          Physical/twin transports, protocol codecs, device service
packages/test-device/     Test-only protocol double and transcript fixtures
packages/analysis/        Traces, markers, detection and characterization
packages/agent/           Atom surface, schemas, policy and Realtime settings
contracts/                Byte-identical trio composition manifest
docs/                     User, support, protocol, ADR, and release documents
tools/                    Hardware probes and release utilities
../TinySA_Firmware/       Executable Renode twin and future stimulus sink owner
../TinySA_SignalLab/      Independent stimulus-authoring application
```

### Ownership rules

| Boundary | Producer | Consumer | Rule |
|---|---|---|---|
| USB bytes | WP-04 transport | WP-05 codec | Bytes and lifecycle events only |
| Parsed commands | WP-05 codec | WP-06 device service | No Electron or UI types |
| Device API/events | WP-06 service | WP-07 bridge, WP-09/10 UI | Types originate in WP-02 |
| IPC | WP-07 main/preload | Renderer | Allow-listed typed methods only |
| Sessions | WP-11 | UI/export | Versioned schema and atomic persistence |
| Fixtures/simulator | WP-03 | All test suites | Deterministic and hardware-independent |
| Capability profile | WP-01/06 | UI | Renderer never infers model rules |
| Executable twin | `TinySA_Firmware` | Device service | Exact bridge v1 evidence; never represented as USB |
| Stimulus intent | `TinySA_SignalLab` | Future Firmware sink | Reserved-not-connected until coordinated activation |
| Atom tool/control topology | `packages/agent` | Renderer host | Exactly one policy, executor, projection and guarantee per hook |

### Required state machines

Connection: `disconnected -> discovering -> connecting -> identifying -> ready -> recovering -> disconnected`, with `faulted` reachable from every active state.

Operation: `idle <-> analyzer`, `idle <-> generator`, with streaming substates. Generator output is an explicit state, never inferred from mode. Transitions stop conflicting activity before configuration changes.

### Assume/guarantee composition rule

For each active producer→consumer edge, release composition is valid only when the producer guarantee implies every consumer assumption: `G_producer => A_consumer`. The three repositories carry byte-identical copies of composition contract v1, and `npm run check:trio-contract` proves identity plus the pinned bridge, firmware, SignalLab, device API, and Atom-surface versions.

- Physical→Atomizer assumes completed discovery, exact ZS407 USB identity, and the required firmware shell; Atomizer guarantees `execution=physical`, `transport=usb-cdc-acm`, and verified USB only after identity.
- Firmware→Atomizer assumes an exact bridge-v1 ready declaration; Firmware guarantees executable-origin sweeps/LCD/touch/generator evidence, `execution=firmware-digital-twin`, and `usbTransactionsModeled=false`.
- SignalLab→Firmware assumes a future explicit stimulus sink; SignalLab currently guarantees only versioned intent and non-impersonation. Because the sink is absent, the composition result must remain `reserved-not-connected`.

Safety invariants hold in every reachable state; liveness requires every admitted request to settle exactly once; failure algebra defines a single visible terminal result for invalid input, discovery, identity, boot, evidence, policy, approval, and Realtime-setting failure. Retry, reroute, downgrade, fabrication, and implicit edge activation are outside the contract.

## 4. Work packages

## WP-00 — Product baseline and repository foundation

**Outcome:** a buildable, governed monorepo with frozen v1 product boundaries.  
**Estimate:** 3–5 ED.  
**Dependencies:** none.

**Deliverables**

- Package manager/workspace, TypeScript configurations, Electron/React shell, test runner, lint/format/type-check commands.
- ADR template and initial ADRs for transport choice, process boundaries, state management, plotting evaluation, storage, and licensing posture.
- Product requirements, glossary, supported-platform draft, feature/capability matrix template, risk register, and contribution guide.
- CI skeleton that installs, builds, checks, and tests on all target OS runners.

**Acceptance**

- A clean checkout produces a sandboxed empty desktop app using one documented command.
- CI runs on macOS, Windows, and Linux; no application package imports source through undeclared paths.
- v1 inclusions/exclusions and decision owners are recorded.

**Excluded:** device implementation and finished UI.

## WP-01 — ZS407 protocol characterization

**Outcome:** evidence-backed protocol and capability specification for the delivered hardware/firmware.  
**Estimate:** 6–10 ED plus access to hardware.  
**Dependencies:** WP-00; physical ZS407.

**Deliverables**

- Read-only probe CLI with port selection, raw byte capture, redaction, timestamps, and bounded timeouts.
- Device identity record: model, hardware, firmware, VID/PID, serial behavior, port names, line settings, prompt/echo/line endings.
- Command catalog with syntax, response grammar, binary framing, state preconditions, safe ranges, readback quality, timeouts, abortability, and observed errors.
- Characterization of `scan`, `hop`, `data`, `frequencies`, `capture`, `refresh`/`bulk`, touch/release, analyzer controls, generator controls, SD reads, presets, and reconnect behavior.
- Versioned capability profile and sanitized golden transcripts/binary fixtures.

**Acceptance**

- Three repeated runs of every accepted command produce explainable transcripts.
- Screen dimensions, RGB format/endian order, frame boundaries, prompt behavior, and fragmented reads are proven from bytes.
- Cable removal is tested during text response, binary response, streaming, and generator configuration without hanging the probe.
- Dangerous/calibration commands are not experimentally invoked without a separately approved test procedure.

**Excluded:** relying on wiki dimensions as test evidence; destructive calibration; DFU.

## WP-02 — Domain and API contracts

**Outcome:** stable, platform-neutral TypeScript vocabulary for the entire system.  
**Estimate:** 4–6 ED.  
**Dependencies:** WP-00; initial WP-01 findings.

**Deliverables**

- Branded types for hertz, dBm, dB, microseconds, sweep point count, operation/device/session IDs.
- Contracts for port candidates, identity, capabilities, snapshots, analyzer/generator configurations, sweeps, traces, markers, screen frames, device events, progress, and typed errors.
- `TinySaApiV2` request/response/event contract and runtime validators for every IPC input.
- Compatibility rules: additive evolution, schema versioning, exhaustive discriminated unions, serialization tests.

**Acceptance**

- Package has no Electron, React, Node serial, or storage dependency.
- Invalid ranges and non-serializable values fail deterministic tests.
- Representative requests/events survive structured-clone and JSON fixture round trips where applicable.
- All downstream owners approve the API review.

## WP-03 — Fake instrument, transcript harness, and fixtures

**Outcome:** deterministic development and CI without physical hardware.  
**Estimate:** 5–8 ED.  
**Dependencies:** WP-01 fixtures, WP-02.

**Deliverables**

- Scriptable fake serial transport and tinySA simulator supporting identification, configuration, sweep data, capture, touch, streaming, errors, delays, and disconnects.
- Transcript record/replay format with metadata and exact byte chunking.
- Fault scenarios: fragmented/coalesced chunks, corrupt/truncated frames, prompt-like binary bytes, missing prompt, late response, unsolicited stream data, cable loss, port rename.
- Test factories and deterministic sample sweeps/screens.

**Acceptance**

- Test suites can select nominal or fault scenarios without timing flakiness.
- Simulator asserts illegal command concurrency and records all host writes.
- Golden replay produces byte-identical results and fixture provenance is documented.

## WP-04 — Serial discovery and transport

**Outcome:** cross-platform, reconnect-aware byte transport owned by Electron main.  
**Estimate:** 5–8 ED.  
**Dependencies:** WP-00, WP-02, WP-03.

**Deliverables**

- Port enumeration, candidate scoring, explicit selection, open/close/read/write/drain, lifecycle and error events.
- USB identity handling that does not depend solely on VID/PID; persisted preference is advisory.
- Bounded optional reconnect with cancellation and port-renaming recovery.
- Native-module packaging/rebuild configuration and Linux permission guidance draft.

**Acceptance**

- Mock and hardware tests cover open failure, busy port, unplug/replug, renamed port, multiple candidates, and application quit.
- No read listener or OS handle leaks across 100 simulated reconnects.
- Transport never interprets tinySA command content.

## WP-05 — Console codec and command scheduler

**Outcome:** lossless parsing and serialized execution across mixed text/binary/stream responses.  
**Estimate:** 8–13 ED.  
**Dependencies:** WP-01 through WP-04.

**Deliverables**

- Single-owner operation queue with per-command grammar, timeout, cancellation, priority, and recovery policy.
- Incremental byte parser for echoed text, prompt-delimited output, numeric rows, capture frames, refresh/bulk frames, and unsolicited bytes.
- Encoders/parsers for every accepted M0 command; raw command capability remains internal and test-only.
- Parser resynchronization and structured diagnostic ring buffer with payload-size limits.

**Acceptance**

- Property/fuzz tests never crash or grow without bound on arbitrary chunking/bytes.
- Golden transcripts parse exactly; prompt-like sequences inside binary data do not terminate frames.
- Timeout/cancel/disconnect settles each operation exactly once and the next operation either starts synchronized or forces reconnect.
- Streaming cannot steal a solicited response.

## WP-06 — Device service, capability engine, and safety policy

**Outcome:** one coherent high-level instrument independent of Electron and React.  
**Estimate:** 10–15 ED.  
**Dependencies:** WP-02, WP-03, WP-05.

**Deliverables**

- Connection and operation state machines; identification and capability negotiation from identity, `help`, status, and safe probes.
- Typed analyzer configuration/acquisition/streaming, generator configuration/output, remote screen/touch, preset, battery/status, and accepted SD operations.
- Range/mode validation, transition sequencing, commanded-versus-verified state, operation IDs, progress and event stream.
- Generator-output safety policy: default off, explicit enable, stop-before-mode-switch, best-effort off on clean disconnect/quit, unmistakable unknown state after cable loss.

**Acceptance**

- State-model tests cover every legal transition and reject every conflicting operation.
- UI-facing results contain no raw protocol strings or platform paths.
- All ZS407 capability-matrix rows map to one typed operation or a documented exclusion.
- Safety test suite proves output cannot become enabled through connect, reconnect, restore, import, or analyzer actions.

## WP-07 — Electron main/preload security bridge

**Outcome:** a minimal secure desktop boundary exposing `TinySaApiV2`.
**Estimate:** 4–7 ED.  
**Dependencies:** WP-02, WP-04, WP-06.

**Deliverables**

- Composition root, lifecycle/quit handling, preload bridge, request validation, event subscription/unsubscription, and error mapping.
- Sandboxed renderer, context isolation, navigation/window-open denial, CSP, no remote content, and production devtools policy.
- Backpressure strategy for sweeps/screens (bounded event delivery or transferable/message-port design after measurement).

**Acceptance**

- Renderer has no Node globals, filesystem, serialport, generic `send`, or arbitrary channel access.
- Malformed IPC is rejected and logged without reaching the device service.
- Window reload/close removes subscriptions and leaves the device in defined state.
- Security checklist and automated smoke tests pass.

## WP-08 — Design system and application shell

**Outcome:** accessible, responsive desktop framework for all product surfaces.  
**Estimate:** 6–10 ED.  
**Dependencies:** WP-00, WP-02; may run alongside WP-04–07 using mocks.

**Deliverables**

- Information architecture and workflows for connection, analyzer, generator, remote screen, sessions, settings, diagnostics, and help.
- Tokens/components for RF numeric entry, units, toggles, status, dialogs, errors, empty/loading/fault states, and persistent generator-output warning.
- App shell, routing/state strategy, command shortcuts, accessible focus/error behavior, high-DPI and dark/light theme behavior.

**Acceptance**

- Complete workflows are reviewable against the simulator at 100%, 150%, and 200% scaling.
- Keyboard-only operation reaches all controls; focus and errors are visible; controls have accessible names.
- Generator enabled/unknown states remain visible from every route.

## WP-09 — Analyzer workspace and visualization

**Outcome:** configure, acquire, inspect, and monitor spectra from the desktop.  
**Estimate:** 12–18 ED.  
**Dependencies:** WP-02, WP-06–08; uses WP-03 until hardware integration.

**Deliverables**

- Frequency start/stop/center/span and point/RBW controls with capability-aware validation.
- Attenuation, LNA/LNA2, AGC, trigger, repeat, spur, trace/calculation and other accepted analyzer controls.
- Single/continuous acquisition, pause/resume, performant trace plot, axes/units, zoom/pan/reset, markers, peak search, delta/readouts, waterfall.
- Freshness, effective settings, commanded/verified state, dropped-frame/backpressure and disconnected indications.

**Acceptance**

- Plotted bins exactly match golden sweep fixtures and exported values.
- A 30-minute maximum-supported streaming soak shows bounded memory and no parser/UI desynchronization.
- Plot interaction stays responsive at the measured maximum device rate on the reference machine.
- Invalid or unsupported settings cannot reach the service.

## WP-10 — Generator and remote-instrument workspaces

**Outcome:** safely operate accepted signal-generator functions and every remaining device UI function.  
**Estimate:** 9–14 ED.  
**Dependencies:** WP-01, WP-06–08.

**Deliverables**

- Capability-driven generator mode, frequency, level, high-frequency mode, modulation, span/level/time sweep, and output controls.
- Two-step or equivalently deliberate output enable, persistent output state, output-off action always reachable, and unknown-state recovery UX.
- Screen capture/refresh display with correct scaling/color, coordinate mapping, touch/release, click-rate governance, and screenshot saving.
- Preset and accepted device utility controls; unsupported operations are documented exclusions rather than substitute paths.

**Acceptance**

- Generator controls never emit an out-of-capability command in boundary tests.
- Output remains off through startup/reconnect/state restore; clean quit attempts off; cable-loss UI immediately becomes unknown.
- Touch coordinates hit corners/center within characterized tolerance at every supported scale.
- Remote-screen soak has bounded memory and cleanly yields the command channel when required.

## WP-11 — Sessions, persistence, import, and export

**Outcome:** reproducible local measurements without corrupting or silently changing device state.  
**Estimate:** 7–11 ED.  
**Dependencies:** WP-02, WP-07, WP-09.

**Deliverables**

- Versioned session schema containing identity/firmware, timestamps, requested/effective settings, sweeps/traces/markers, annotations, and units.
- Atomic local persistence, retention controls, recent sessions, schema migration, corrupted-file quarantine, import preview.
- CSV and JSON measurement export; PNG plot/screen export; filename and locale-independent numeric policy.
- Preference storage separated from sessions and from live device state.

**Acceptance**

- Round trips preserve numeric measurement values and provenance exactly within documented representation.
- Interrupted writes do not destroy the last valid session.
- Import never executes device commands; applying imported settings is a separate validated explicit action and cannot enable RF output.
- Golden exports open correctly in common spreadsheet/image tools and document their schema.

## WP-12 — Diagnostics, resilience, and supportability

**Outcome:** failures are recoverable and diagnosable without exposing sensitive host data.  
**Estimate:** 5–8 ED.  
**Dependencies:** WP-04–11.

**Deliverables**

- Structured rotating logs, bounded protocol ring buffer, operation correlation, redaction, and exportable support bundle.
- User recovery for no device, permissions, busy port, unsupported firmware, parser desync, timeout, unplug, storage failure, and crash restart.
- Health/status view with app/build/platform/device/firmware/capability information.

**Acceptance**

- Injected failures lead to actionable UI messages and preserve diagnostic cause chains.
- Support bundle contains required reproduction metadata but no home-directory username, unrelated ports, session contents, or raw data unless explicitly included.
- Repeated failure/recovery does not leak handles, listeners, timers, or unbounded logs.

## WP-13 — Verification and hardware qualification

**Outcome:** traceable evidence that the assembled product meets its contract.  
**Estimate:** 12–18 ED distributed across development, plus hardware/platform access.  
**Dependencies:** begins WP-00; final acceptance depends on WP-01–12.

**Deliverables**

- Requirements-to-test traceability matrix and test strategy covering unit, contract, integration, UI, hardware-in-loop, security, performance, soak, recovery, and exploratory RF workflows.
- CI suites using simulator; controlled hardware smoke/qualification scripts with device and firmware identity in results.
- Supported-platform matrix for install, permissions, discovery, acquisition, capture/touch, generator safety, disconnect, sleep/wake, quit, upgrade, and uninstall.
- Release-candidate defect report and signed acceptance record.

**Acceptance**

- All global and package criteria have linked passing evidence.
- Required hardware workflows pass three consecutive times per supported OS without manual protocol intervention.
- 8-hour analyzer soak and 1-hour remote-screen soak have bounded resources and zero unexplained desynchronization.
- No S1/S2 defects; deferred S3/S4 items have owner-approved release notes.

## WP-14 — Packaging, supply chain, documentation, and release

**Outcome:** reproducible, installable, supportable v1 artifacts.  
**Estimate:** 8–13 ED plus certificate/provisioning lead time.  
**Dependencies:** WP-00, WP-07, WP-12, WP-13.

**Deliverables**

- Reproducible packaging for frozen platform/architecture matrix; native serial binding rebuilds; app icons/metadata/versioning.
- Signing and notarization where applicable, checksums, release provenance, dependency lock, license notices, SBOM, vulnerability disposition.
- Update policy and mechanism (or explicitly manual signed updates); rollback and preference/session migration tests.
- User guide, quick start, RF/input safety, generator warnings, troubleshooting, Linux permissions, privacy statement, known limitations, developer/build/protocol docs, support playbook, release notes.

**Acceptance**

- Clean-machine installation and smoke suite pass from the actual release artifacts.
- Installed production build contains no test console, unpackaged source maps/secrets, or unrestricted devtools.
- Upgrade preserves valid data; failed update has documented recovery; uninstall behavior matches documentation.
- A new developer can build/test from the delivered instructions and a new user can connect/acquire/export without undocumented steps.

## WP-15 — Signal detection and event tracking

**Outcome:** evidence-backed, configurable detection of RF emissions with stable event tracking.  
**Estimate:** 12–18 ED plus representative capture collection.  
**Dependencies:** WP-02, WP-06, WP-09, WP-11, hardware fixtures from WP-01.

**Deliverables**

- Versioned detector contract with absolute and noise-relative thresholds, minimum bandwidth and persistence.
- Declared noise-floor estimator, deterministic contiguous-bin segmentation, quality flags and source-sweep provenance.
- Stateful cross-sweep tracker with documented association, drift, merge/split, expiry and stable-ID behavior.
- Detection workspace, synchronized plot bands/table/detail, filtering, alert policy boundary and session persistence.
- Synthetic golden corpus and labeled captured corpus; quality/performance report.

**Acceptance**

- DET-01 through DET-10 in `docs/UI_UX_CONTRACTS.md` pass and link to evidence.
- Empty, zero-result, unavailable, cancelled and failed analysis remain semantically distinct.
- Detector and tracker run outside serial/IPC ownership and cannot mutate device state.
- Precision/recall, false alarms, SNR response and estimation error meet thresholds frozen after WP-01 capture characterization.
- Continuous tracking has bounded memory and deterministic replay from a recorded session.

## WP-16 — Classification infrastructure and model lifecycle

**Outcome:** safe local waveform-classification pipeline with candid unknown behavior.  
**Estimate:** 10–16 ED.  
**Dependencies:** WP-02, WP-07, WP-11, WP-15.

**Deliverables**

- Versioned analysis-mode interface, candidate/evidence contracts, cancellable local inference adapter and pipeline state machine.
- Inert signed model-package manifest, size/hash/schema/domain validation, installation/removal and compatibility reporting.
- Classification workspace with candidate selection, pipeline stages, ranked results, calibrated confidence, unknown reasons and provenance.
- Model-independent fixtures proving that missing/invalid/out-of-domain packages cannot invent labels or execute arbitrary code.

**Acceptance**

- CLS-01 through CLS-05, CLS-08 and CLS-09 pass without requiring a trained production model.
- Missing model is `unavailable`; low confidence/out-of-domain is `unknown`; inference faults are `failed`.
- Model installation occurs in a trusted process and loads no executable scripts from the package.
- Classification never receives transport, raw IPC, filesystem or generator capabilities.

## WP-17 — Classification corpus, training and validated model

**Outcome:** a reproducible classifier whose stated domain and performance are scientifically defensible.  
**Estimate:** 20–40 ED after the capture protocol and taxonomy are frozen; RF capture time is additional.  
**Dependencies:** WP-01, WP-13, WP-15, WP-16; representative signals and RF lab access.

**Deliverables**

- Waveform taxonomy, capture protocol, labeling guide, data governance/license record and versioned corpus manifest.
- Session/source-grouped train/validation/test splits plus explicit open-set and out-of-domain sets.
- Reproducible preprocessing, baseline comparisons, training, calibration, evaluation and model packaging pipeline.
- Model card stating supported devices, firmware, ranges, RBW/points, classes, exclusions, metrics, failure modes and compute budget.
- Signed local model package and regression fixtures.

**Acceptance**

- CLS-06, CLS-07 and CLS-10 pass together with all WP-16 criteria.
- No physical capture session or source identity leaks across evaluation splits.
- Published per-class precision/recall/F1, macro metrics, confusion matrix, calibration error and coverage-risk curve meet owner-approved thresholds.
- Open-set evaluation demonstrates the agreed unknown-detection behavior.
- A clean build reproduces the accepted model artifact or documents deterministic tolerance and exact provenance.

## WP-18 — AI-native application and tool foundation

**Outcome:** every application capability has a governed agentic surface using the same domain APIs as the UI.  
**Estimate:** 7–11 ED.  
**Dependencies:** WP-02, WP-06–12, WP-15–16.

**Deliverables**

- Exact model constants, Atom system contract, application-context projection and typed tool/result/approval contracts.
- Closed tool catalog with runtime validators, risk classes, action-time approval policy and bounded orchestration loop.
- Agent-hook completion rule for all future features and source-to-contract traceability.
- Hobbyist/engineer behavior profiles without changing safety authority.

**Acceptance**

- AI-01, AI-06–12, AI-15–16 and AI-19 in `docs/AI_NATIVE_CONTRACTS.md` pass.
- Raw serial, unrestricted IPC, calibration, DFU, deletion and arbitrary filesystem/network operations are absent.
- Text, voice and app-computer paths use one tool validator and policy table.

## WP-19 — Native Realtime voice

**Outcome:** low-latency speech-to-speech operation with `gpt-realtime-2.1-mini`.  
**Estimate:** 6–10 ED plus microphone/platform qualification.  
**Dependencies:** WP-07, WP-18.

**Deliverables**

- Trusted unified WebRTC SDP gateway, renderer peer/media lifecycle, server VAD/interruption, transcript and Realtime function-call loop.
- OS microphone permission/packaging configuration, voice states, cancellation and resource cleanup.
- Voice-specific RF task and duplicate-execution evals.

**Acceptance**

- AI-01–06, AI-17–18 pass on primary platforms.
- `OPENAI_KEY` never crosses main/preload; media resources close on every exit/failure path.
- Barge-in does not duplicate or replay an instrument operation.

## WP-20 — Text agent transport and app-scoped computer use

**Outcome:** multi-step text agent and semantic computer operation confined to TinySA Atomizer.  
**Estimate:** 6–10 ED.  
**Dependencies:** WP-18.

**Deliverables**

- One trusted text-only Realtime WebSocket path using exactly `gpt-realtime-2.1-mini`; no alternate model, API, endpoint, transport, alias, reroute, or automatic retry.
- Opaque conversation IDs, bounded function-output loop, trusted-main socket ownership, four-session capacity and five-minute idle expiry.
- Semantic interface map plus app-window-only screenshot/click/type/key/scroll actions that cannot reach the OS desktop or bypass domain policy.
- Shared transcript/tool activity/approval UX and actionable API error taxonomy.

**Acceptance**

- AI-01–03, AI-06–16 and AI-21–24 pass.
- Computer actions are screenshot-relative, bounded to the TinySA Atomizer content area, and cannot address URLs, other windows or RF enable.
- Native tools are selected over computer actions for exact measurement configuration in evals.

## WP-21 — Agent security, privacy, RF evals, and release qualification

**Outcome:** evidence that Atom is useful, honest, safe and private for hobbyist and engineering workflows.  
**Estimate:** 8–14 ED distributed across agent development.  
**Dependencies:** WP-13, WP-18–20.

**Deliverables**

- Prompt-injection threat model, data minimization/retention policy, approval red-team suite and secret/build-artifact scan.
- RF knowledge, tool selection/arguments, multi-step, voice, interruption and computer-use eval suites.
- Platform microphone/network/rate-limit/failure qualification and owner-reviewed release report.

**Acceptance**

- AI-01 through AI-24 have passing linked evidence.
- No credential, raw audio, transcript or raw sweep leaks into default logs/diagnostics/artifacts.
- Zero policy-bypass or unapproved RF-enable cases across the release red-team corpus.
- RF expert accepts the supported-domain claims and known limitations.

## WP-22 — Advanced swept measurements and bounded instrument stage

**Outcome:** the Spectrum route provides the core measurement workflows common
to entry spectrum analyzers without scrolling, hidden data, or unsupported I/Q
claims.
**Estimate:** 8–14 ED plus physical/RF qualification.
**Dependencies:** WP-02, WP-07–08, WP-15, WP-18.

**Deliverables**

- Runtime-validated view, waterfall, channel-definition, OBW, and envelope-STFT
  contracts with explicit scalar-sweep/Not-I-Q provenance.
- RBW-normalized band-power integration, lower/upper ACP/ACLR, configurable
  percent-power OBW, and deterministic Hann-windowed envelope STFT engines.
- One fixed-height Spectrum/Waterfall/Channel/Time-STFT stage with setup and
  trace/marker/display overlays; 1720 × 1040 work-area-clamped startup sizing.
- Typed Atom selection/configuration/result/acquisition hooks and minimized
  application context for every new view.
- Official-vendor workflow research, evidence boundary, failure matrix, unit
  fixtures, renderer interaction tests, and populated simulator screenshot audit.

**Acceptance**

- ADV-001 through ADV-014 in `docs/ADVANCED_MEASUREMENTS_CONTRACT.md` pass.
- No frequency-grid interpolation, requested-RBW substitution, out-of-span
  partial result, or I/Q/vector claim is permitted.
- Physical ZS407 validation records integration error versus a characterized
  source across representative RBW, span, point-count, level, and detector cases
  before channel results may be promoted beyond engineering estimates.

## 5. Integration gates

| Gate | Required packages | Exit evidence |
|---|---|---|
| G0 Foundation | WP-00 | Green cross-platform shell CI and approved baseline |
| G1 Protocol truth | WP-01–03 | Capability profile, fixtures, approved API, deterministic simulator |
| G2 Device SDK | WP-04–06 | Hardware connect/acquire/capture/touch and safety demonstrations |
| G3 Secure vertical slice | WP-07–09 partial | Packaged dev build connects, displays one sweep, disconnects safely |
| G4 Feature complete | WP-08–12, WP-15–16, WP-18–20, WP-22 | Capability matrix closed; visual, advanced-measurement, and agentic workflows work on simulator and reference hardware |
| G5 Analysis qualified | WP-17 | Accepted corpus, model, open-set/calibration evidence and signed model package |
| G6 Agent qualified | WP-21 | AI security, RF, voice, tool and computer-use eval gates pass |
| G7 Release candidate | WP-13–14 | Platform qualification, signed artifacts, docs, no release blockers |
| G8 Acceptance | all | Global definition of done and owner sign-off |

No UI milestone may waive G1/G2 hardware truth. Simulator success is necessary but is not hardware acceptance.

## 6. Dependency and staffing plan

Critical path:

```text
WP-00 -> WP-01 -> WP-02/03 -> WP-04/05 -> WP-06 -> WP-07
                                              |          |
                                              +----> WP-09/10 -> WP-12/13 -> WP-14
                                                       |
                                                       +----> WP-15 -> WP-16 -> WP-17
                                                       +----> WP-18 -> WP-19/20 -> WP-21
                                                       +----> WP-22
WP-00 -> WP-08 -------------------------------+
WP-02 -> WP-11 -------------------------------------------> WP-13
```

Suggested ownership lanes:

- **Device/protocol engineer:** WP-01, WP-04–06; supports WP-10 and hardware QA.
- **Desktop platform engineer:** WP-00, WP-07, WP-12, WP-14.
- **Product/UI engineer:** WP-08–11, WP-22 UI.
- **Analysis/ML engineer:** WP-15–17, WP-22 math; partners with RF acceptance owner on corpus and measurement validity.
- **Agent/voice engineer:** WP-18–21; partners with platform, product and RF safety owners.
- **Quality/release engineer:** WP-03, WP-13, release portions of WP-14.
- **Product owner/RF acceptance owner:** scope decisions, capability-matrix disposition, safe-range review, milestone acceptance.

Nominal total is **181–297 ED**, including signal detection, classification, the first validated model, advanced swept measurements, native voice/agent/computer operation, package-local engineering, and explicit verification/release work. A single cross-disciplinary engineer should plan roughly 10–16 elapsed months after hardware arrival. A coordinated desktop/protocol/analysis/agent team can overlap lanes after G1 and target roughly 5–8 elapsed months; hardware characterization, corpus collection, measurement validation, and agent qualification remain evidence gates.

## 7. Required owner-supplied items

- Genuine ZS407 hardware, USB data cables, and permission to update to a named stable firmware if characterization finds a blocker.
- Safe RF test setup: 50-ohm loads/attenuators, known source or frequency reference, appropriate adapters, and an RF-aware acceptance reviewer.
- macOS/Windows/Linux test hosts or hosted access; Apple Developer ID and Windows signing credentials if signed public distribution is required.
- Product name/branding, repository/license decision, distribution channel, privacy/telemetry choice (default: none), and supported OS/CPU decision.

## 8. Explicit exclusions and optional change packages

Excluded unless added by change order: DFU/firmware flashing; custom tinySA firmware; calibration writes; factory reset; unrestricted raw console; multiple simultaneous devices; remote/network access; cloud sync; accounts; mobile/web apps; automated regulatory/compliance measurements; control of other tinySA/NanoVNA models; third-party executable plug-ins; localization; app-store submission. An internal typed analysis-mode extension interface is included.

Potential follow-on packages:

- **CP-01 DFU:** signed firmware catalog, DFU transport, power-loss/recovery qualification.
- **CP-02 Multi-device:** identity, parallel operation, UI and resource isolation.
- **CP-03 Automation API:** authenticated local API, scripting and headless runner with RF safety policy.
- **CP-04 Additional models:** per-model hardware characterization and capability profiles.
- **CP-05 Compliance analysis:** editable masks/limit lines, harmonics/TOI orchestration, C/I, antenna corrections, report templates, and measurement validation beyond the implemented CHP/OBW/ACP baseline.

## 9. First authorization slice

Authorize G0 and G1 first: WP-00 through WP-03. Before the unit arrives, WP-00, draft WP-02, and simulator scaffolding can proceed from public documentation. WP-01 begins on delivery; its evidence freezes the v1 command grammars and screen framing. The go/no-go review after G1 confirms scope, estimate, platform matrix, and any firmware limitations before committing to the full UI build.
