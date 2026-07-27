# ADR 0004: Instrument drivers are the Atomizer device boundary

- Status: accepted
- Date: 2026-07-14
- Amended: 2026-07-27 for the in-process SignalLab v2 contract

## Context

Atomizer originally composed `TinySaDeviceService` directly in Electron main. That made the physical ZS407 protocol, application startup, and operator UI one implicit device contract. It also encouraged a synthetic source to masquerade as a serial port or firmware device. SignalLab is now a live high-level measurement source with synthetic scalar measurements and bounded deterministic complex I/Q for all 42 closed profiles: 31 content-addressed fixed digital artifacts, eight analytic lab/reference generators, and three custom standards builders. A future NeptuneSDR integration would add materially different hardware identity, configuration, native formats, and streaming semantics. The application needs one boundary that admits present and future sources without erasing what each one can honestly prove.

## Decision

Atomizer interacts with measurement sources only through a statically registered `InstrumentDriver`. A driver owns discovery, connection, capability declaration, configuration, acquisition, optional features, source-specific protocol adaptation, and safe disconnect for one or more explicit source kinds.

The transport-neutral lifecycle code lives in
`@tinysa/instrument-runtime`. It owns the driver/session interfaces, static
registry, serialized manager, and measurement fingerprinting and depends only
on `@tinysa/contracts` and Zod. It imports no adapter, but it is contract-aware
and enforces the current closed source/provenance and SignalLab feature
variants. `apps/desktop/src/shared/in-process-signal-lab-driver.ts` depends only
on that runtime, the contracts, and sibling SignalLab's platform-neutral
service; it has no TinySA or `serialport` dependency. `@tinysa/device`
separately owns the `tinysa-zs407`
adapter plus TinySA-specific serial, Renode, parser, scheduler, and
device-service code. Its old generic module paths and runtime re-export are
removed; host and driver code imports the runtime and each source adapter
from their owning packages. This package
direction keeps source provenance and consumer evolution explicit and prevents
a future driver from acquiring another adapter's protocol or transport
dependency merely to participate in the lifecycle.

`InstrumentManager` is the application-owned lifecycle boundary. It:

- runs each registered driver's discovery independently and retains per-driver failures;
- issues one opaque discovery revision and rejects stale or substituted candidates;
- permits one serialized active session;
- binds every configuration and measurement to opaque session and configuration revisions;
- validates declared capabilities before dispatch;
- reconciles each acquisition's event and return into one deeply equal, atomically projected measurement;
- validates every driver result again at the boundary;
- solely owns RF output state, distinguishing command-acknowledged physical state from executable-twin state without claiming calibrated measurement;
- marks output unknown before output-affecting dispatch, establishes off for configuration and every acquisition, and requires explicit output-off recovery after uncertain state or touch;
- requires acknowledged RF output-off before disconnecting an RF-capable session; and
- isolates driver and consumer event failures from lifecycle state.

Electron main owns the registry, manager, startup preference, IPC adapter, and any source process lifetime. The sandboxed renderer receives only `AtomizerInstrumentApiV1`. It receives runtime-validated candidate descriptors, capabilities, status, and measurement values, never serial or process handles or a generic IPC primitive.

## Pre-session connection ownership is explicit

Connection ownership changes through explicit handoff phases:

- From the first opened transport, spawned process, or other live resource until `connect()` returns a session candidate, the selected `InstrumentDriver` owns a pre-session connection lease.
- While validating that returned object, `InstrumentManager` owns a provisional rejected-session teardown lease. If validation and its first disconnect both fail, the manager retains a safely captured callable disconnect, publishes no session, blocks reconnect, and retries this teardown before any driver pending-connection cleanup. If no callable can be captured (including a throwing accessor), the manager retains only a cleanup barrier and delegates teardown to the required driver hook; it never stores an impossible closure that could permanently prevent aggregate cleanup.
- After admission, `InstrumentManager` owns teardown through that session. A failed admitted-session disconnect retains the session and may not be bypassed by a lower-level cleanup hook.
- Every driver must implement idempotent `cleanupPendingConnection()`. The registry rejects a driver that omits it. The hook must retain and retry every resource for which close/exit was not confirmed; reconnect is blocked while such a lease remains.
- Public `InstrumentManager.disconnect()` is the atomic aggregate teardown. It first disconnects the admitted session, then retries any manager-owned rejected-session lease, then invokes pending-connection cleanup on every statically registered driver. It attempts every registered driver cleanup even if another pending cleanup fails. A failure remains visible and the next disconnect/quit retries the same order.
- Electron's before-quit gate remains intercepted until that compound manager teardown succeeds. Synchronous `dispose()` is not a substitute for confirmed asynchronous connection cleanup.

Today `tinysa-zs407` forwards the required hook to `TinySaDeviceService`, which retains its scheduler, transport, and acknowledged RF-off teardown state across a failed connect/close. The in-process `signal-lab` source owns no external transport or child process, but still supplies the required idempotent cleanup hook. Thus the registry aggregate covers both current drivers; it is not a TinySA-only application callback.

This rule is mandatory for every future resource-owning driver. Registering NeptuneSDR, for example, requires its driver to retain and clean any USB/network/native-library resource opened before session admission and to participate automatically in the manager's aggregate disconnect and quit gate. The current TinySA and SignalLab hooks do not, and cannot be interpreted to, cover NeptuneSDR or any other later driver. Its composition tests must force failure before session return, failure of the first cleanup attempt, and success of a later disconnect/quit retry without leaking the resource or bypassing an admitted session.

## Source identity is not flattened

Candidate descriptors are a strict discriminated union:

- `serial-port` may carry USB/serial evidence;
- `tinysa-firmware-twin` carries executable-firmware provenance and explicitly states that USB transactions are not modeled;
- `signal-lab` carries only a SignalLab-owned synthetic source identifier; and
- any future NeptuneSDR source kind must define its own identity and provenance instead of borrowing TinySA fields.

SignalLab is a high-level measurement producer. Atomizer's shared in-process
driver bundles the sibling repository's platform-neutral service and versioned
contract, then maps admitted scalar spectrum, detected-power, and bounded
deterministic complex-I/Q results for all closed profiles.
It depends only on contracts and the transport-neutral runtime. It is never a
`ByteTransport`, never receives TinySA shell commands, and never claims a USB
identity, firmware version, RF generator, display, or touch surface. Its
complex-I/Q capability is explicitly simulation-native and is not hardware
evidence. Thirty-one fixed profiles bind content-addressed independently
verified digital artifacts and per-profile native geometry/replay policy; eight
lab/reference profiles are analytic generators and three custom profiles are
standards-derived builders. Exact native, clean-derived, and impaired results
retain distinct qualifications and an exact transform receipt. Those claims
cover digital bytes and lineage, not RF emission, antenna behavior,
interoperability, regulatory approval, or product certification.

Within Atomizer, TinySA's driver is the sole adapter allowed to know the ZS407 shell, USB admission, executable-twin bridge, firmware identity, screen/touch behavior, or generator safety semantics. The existing low-level TinySA service remains internal to that driver.

Physical serial discovery admits only exact `0483:5740` endpoints and bounds enumeration, open, and close. A handle returned after open timeout is closed as an orphan; uncertain close blocks later writes. Unrelated endpoint bytes never enter a TinySA session.

Every physical open requests the platform serial library's exclusive native
lock. A lock denial is a failed connection, never permission to share a CDC
stream with TinySA Flasher or another process. This is deliberately narrower
than a cross-application lease: composition v5 contains no Atomizer↔Flasher
runtime edge, so current ownership handoff remains an explicit local-human
disconnect/finish action. A durable or automatic handoff requires a newly
versioned contract implemented and tested by both applications; port absence,
DFU appearance, or updater write-lock state alone cannot establish it.

Unknown but syntactically valid physical firmware revisions may be warning-admitted only as `custom-unqualified`, without invented source provenance or hardware/RF qualification. One exact clean custom receiver identity may instead bind a frozen audited source commit and narrowly source-proved point range as `custom-source-qualified-receive-only`; its serial runtime does not attest the documented binary and it inherits no OEM or unrelated feature authority. Operational compatibility never grants firmware-installation authority. Standalone `Atom-Flasher` owns OEM and custom artifact admission and physical update transactions. Its safety chain (write-started journal, RF-off-before-flash, USB admission, pinned OEM sha) is pinned by its own immutable contract test and safety suite.

TinySA capabilities are connection evidence, not a static OEM profile. After identity and mandatory RF-off/readback commands succeed, `TinySaDeviceService` derives `DeviceCapabilities` from that session and the driver projects only those capabilities into the generic instrument contract. Supported OEM, executable-twin, and protocol-fixture revisions may use the pinned ZS407 ranges, but optional commands still gate optional acquisitions and features. A `custom-unqualified` revision receives no OEM firmware defaults and keeps sweep points at observed geometry. The exact frozen custom receiver gets only its audited 20–450 point proof; all other controls remain safe-probed/device-observed. Exact physical `0483:5740` and strict ZS407 product evidence admit the hardware's bounded 0–900 MHz normal receive path, while the startup span is treated only as current state. Every retune is accepted only after acknowledged output-off/input-mode commands and exact geometry readback, and every reduced-custom public acquisition reasserts output-off. Receiver control ranges and automatic modes come from parseable command usage, and enum controls come only from advertised syntax. Ultra/harmonic receive, leveled triggers without an advertised threshold, generator, screen, touch, and firmware markers are withheld. Unknown or malformed ranges fail closed. A custom surface that cannot form at least one complete acquisition is rejected and its pre-session transport is cleaned up.

Withholding the public generator feature does not weaken RF safety. `output off` remains a mandatory connection and teardown command, every TinySA configuration begins by acknowledging it, and a reduced custom-firmware session reasserts it immediately before acquisition inside the driver. If such a session advertises touch, the driver also requires output-off recovery after every attempted gesture, including a failed touch/release transaction. Thus `rfOutput: not-supported` means “no admitted generator control,” not “the adapter stopped enforcing the device's non-emitting state.”

## Default selection

Main process persists a strict `{driverId, candidateKind, candidateId}` startup preference for every new selection. Legacy version-1 records without `candidateId` remain readable but never manufacture identity and fail on ambiguous broad matching. With no persisted choice, the factory default is the exact `signal-lab:default` candidate. A corrupt preference, failed preferred driver, unavailable preferred source/candidate, or ambiguous legacy match is visible and does not fall through to another driver. Connecting one candidate does not silently rewrite the default; a separate explicit operator preference action does.

This is a preference, not an availability heuristic. Connecting a physical TinySA must never silently replace SignalLab, and a failed SignalLab bridge must never silently activate hardware or the firmware twin.

## Admission and retention ceilings are part of the contract

Driver neutrality does not authorize unbounded data. Instrument contract v1 exports one absolute limit table for scalar vectors, complete I/Q buffers, screen geometry and bytes, discovery collections, capability collections, profiles, diagnostics, strings, frequency, duration, power, and sequence values. These are protocol ceilings rather than claims about any current device. Every driver result is parsed before it can replace discovery state, session state, evidence, or IPC output. A future NeptuneSDR driver must fit inside these v1 ceilings or introduce an explicitly versioned acquisition contract; advertising a larger value is not implicit permission to allocate it.

Admission is independently bounded at each asynchronous ownership layer:

- the renderer admits one compound instrument transaction and one remote gesture, and continuous measurements use a bounded active/pending projection path;
- Electron main shares one 32-operation pending cap across all privileged instrument, file, AI, and computer handlers;
- `AtomizerInstrumentHost` and `InstrumentManager` each admit at most 64 normal pending operations and reserve one coalesced RF-safe teardown slot, which runs immediately after active work and ahead of queued normal work;
- the TinySA command scheduler admits at most 64 active-plus-queued commands in addition to its byte-buffer ceiling; and
- SignalLab is invoked synchronously in-process and has no independent input queue or child generation. Host/manager operation ceilings bound calls, while strict producer and consumer schemas bound every returned vector, string, catalog, and I/Q payload.

Overflow is an explicit failure, never a retry, fallback, hidden queue, or reason to skip output-off/disconnect. The separately reserved teardown slots exist only for idempotently coalesced RF-safe cleanup. Text sweep export v1 admits at most 100,000 points and emits at most 8 MiB after complete strict provenance/vector validation. Development-launcher diagnostics retain one 4 MiB log plus one bounded rotation and truncate any single process-output append above 64 KiB.

Continuous scalar acquisition is one-in-flight and completion-paced to at most 10 acquisitions per second by default. Stop interrupts the pending cadence slot immediately and waits only for a currently executing acquisition. This keeps in-process synthetic generation from becoming an unbounded main/renderer producer.

## Scalar configuration truth and v1 evolution

Atomizer instrument contract v1 and `AtomizerInstrumentApiV1` remain internal, pre-publication boundaries. No external driver SDK or stable application release has published their former geometry-only scalar configuration. The required-field change described here is therefore an intentional pre-publication correction to v1, not an unannounced change to a released contract. Once an external release or third-party consumer publishes this boundary, any required-field or semantic change must introduce a new instrument/API contract version and an explicit compatibility policy.

Every scalar capability and admitted scalar configuration now carries a closed, versioned control model:

- `receiver` is the generic scalar-receiver profile, not a claim that the source is a TinySA or even physical hardware. It names the controls whose semantics are common to scalar receiver acquisition. A driver advertises its exact formats, ranges, automatic modes, detector modes, spur handling, gain state, and trigger modes. A configuration contains the complete applicable control set. A future scalar NeptuneSDR adapter may advertise singleton sets for fixed controls, or reject this acquisition profile and expose only complex I/Q; it may not accept and ignore a field.
- `synthetic-scalar` carries exact simulated sweep timing and its qualification only. It has no fields for RF filter bandwidth, front-end attenuation, detector, LNA, spur rejection, acquisition transfer format, or hardware trigger, so a synthetic source cannot be configured or exported as though those settings existed.

The capability model and configuration model must match before dispatch. `InstrumentManager` range-checks every numeric value and admits every enum against the capability; unsupported automatic values, steps, modes, trigger levels, or cross-model substitutions fail before the driver is called. The authoritative command is deeply frozen, a parsed clone is dispatched, and the authoritative value is parsed and capability-checked again after the driver returns, so an in-process driver cannot mutate admitted state. TinySA's adapter translates every admitted receiver field to `AnalyzerConfig` or `ZeroSpanConfig` without defaults. TinySA declares the firmware CLI's truthful request resolution: 0.1 kHz RBW and 1 µs sweep time. SignalLab advertises and accepts exactly a 0.05-second `simulation-exact` scalar sweep and rejects any other timing or receiver control model. Detected-power measurements must preserve the admitted timing model: synthetic controls require `simulation-exact`, while receiver controls cannot claim it in v1.

TinySA configuration is command-acknowledged, not globally read back as “verified.” Sweep geometry, actual RBW, attenuation, and status have query evidence; transfer format, requested sweep-time mode, detector, spur handling, LNA, avoid-spurs, and trigger do not have a complete firmware query surface. Those fields therefore retain command acknowledgement while measurements preserve the separately observed RBW and attenuation. Automatic sweep time is never represented by omission: the firmware implementation at `sa_cmd.c:cmd_sweeptime` accepts numeric seconds, and `sa_core.c:set_sweep_time_us` defines literal zero as automatic/minimum time, so the adapter sends `sweeptime 0`. A bare `sweeptime` query reports actual elapsed duration and is not misrepresented as readback of the requested automatic mode. RBW, attenuation, spur handling, avoid-spurs, and automatic trigger likewise receive explicit commands.

Detected-power configuration is a real prepare phase. It turns RF output off, enters input mode, sends every receiver control, and reads the available geometry/RBW/attenuation evidence before the manager publishes a configuration revision. Acquisition only consumes that prepared revision; it never performs a hidden first-time configuration after the host has reported success.

The manager's successful configuration response is the authoritative admitted configuration. The renderer retains that returned value by its opaque revision and projects it into `Sweep.requested` or `ZeroSpanCapture.requested`; it never reattaches staged UI intent. Configuration acknowledgements that differ from the request are rejected. Persisted UI staging is reconciled visibly to every active receiver range, step, automatic-mode declaration, enum set, and trigger range before first configuration. Atom receives admitted state and explicitly labelled staging; under SignalLab, receiver-only staged values are omitted and marked not applicable. Profile IDs remain session capability/status only and never enter configuration, measurement, detector, classifier, or export evidence.

Source provenance also constrains capability truth in v1. SignalLab may expose synthetic scalar spectrum/detected-power acquisition, profile/channel selection, and bounded deterministic complex I/Q for all 42 explicitly advertised closed profiles. Eight lab/reference generators retain `analytic-complex-baseband`; three custom builders retain `standards-derived-complex-baseband`; 31 fixed artifacts distinguish exact native `independently-verified-digital-baseband`, clean `derived-from-independently-verified-digital-baseband`, and explicit receiver-impaired output. RF generator, screen, touch, diagnostics, and receiver controls remain rejected at session admission. Serial and firmware-twin scalar acquisitions require receiver controls. Export admission mirrors this binding, binds the complete requested closed/half-open frequency grid to samples, and uses generic instrument ceilings rather than TinySA frequency limits. JSON preserves the full admitted request, and CSV carries it in `requested_configuration_json`.

Instrument v1's source-provenance union remains closed to `serial-port`,
`tinysa-firmware-twin`, and `signal-lab`. The renderer has capability-gated
scalar and complete-buffer I/Q surfaces, while scalar staging remains TinySA-shaped. NeptuneSDR cannot borrow serial-port or any
other existing provenance merely because its transport may be USB or serial.
A truthful first-class Neptune transport/provenance variant and hardware-specific
configuration/export evolution are required; it must not be smuggled through a
false existing source or projected into scalar controls.

The paired SignalLab measurement bridge v2 is still pre-publication. Its exact in-process schema includes per-profile governance, native/output I/Q geometry, cyclic/one-shot replay, explicit receiver impairment, payload SHA-256, and transform receipts, plus a required safe-integer detected-power center on an advertised 1 Hz tuning lattice. The producer contract, catalog, and domain-separated contract binding are hash-bound; the binding is explicitly not generator-code identity. An older strict Atomizer build rejects the producer before dispatch. Once this boundary has a stable external release, a wire-field or semantic change requires a new bridge contract version rather than mutation of v2.

## Capability growth and NeptuneSDR

The base contract contains common acquisition variants, swept scalar spectrum, uniformly sampled detected power, and a complete single-buffer complex-I/Q shape capped at 64 MiB, plus narrowly typed optional features. Continuous complex-IQ acquisition is rejected; chunking, continuation, backpressure, or long-lived streaming requires a new contract version. SignalLab advertises bounded complete-buffer `cf32le` for all 42 closed profiles, including exact per-profile geometry, transport derivation, replay bounds, and qualification; `tinysa-zs407` advertises none. The UI and agent surface derive availability from those declarations.

New common semantics require a versioned contract addition with manager validation and at least two credible consumers; they are not placed in an untyped options bag. A truly source-specific operation would require a driver-owned, separately versioned extension contract and would remain unavailable to other drivers; instrument v1 has no generic extension hook. NeptuneSDR is not registered or supported today. The transport-neutral runtime package solves only driver lifecycle coupling; it does not make source registration open-ended. Adding NeptuneSDR still requires a distinct driver/source identity, truthful hardware capabilities and provenance, native-format export and configuration paths, consumers, contract tests, pre-session lease cleanup through the required driver hook, and a coordinated trio-contract revision. Long-lived I/Q additionally requires a versioned streaming contract for chunking, ordering, backpressure, cancellation, and bounded retention; the existing complete single-buffer I/Q value and renderer are not a streaming protocol or hardware admission.

## Consequences

- The extracted runtime avoids a rewrite of Atomizer's lifecycle; adding a
  source still requires the explicit contract, adapter, consumer, composition,
  and validation evolution described above.
- A new driver cannot enter the trusted registry without an explicit pre-session cleanup lifecycle; existing driver cleanup never implicitly covers its resources.
- Source failures and evidence remain attributable to their owner.
- Synthetic measurements can exercise Atomizer's real detection and classification path without becoming classifier ground truth or fake hardware evidence.
- Generic acquisition configuration cannot silently discard requested source-specific controls; an adapter must either implement, explicitly translate, or reject them.
- Driver, manager, IPC, and producer contracts are versioned and tested independently, with real producer/consumer interoperation required for a SignalLab release.
- Release regenerates the deterministic Bayesian classifier model and requires byte identity with both checked-in generated assets; validating a stale but internally consistent asset is insufficient.
- Trio composition v5 records the active in-process SignalLab v2 measurement edge, selectable TinySA physical/twin sources, factory-default/no-fallback rule, reserved SignalLab stimulus edge, and Atom-Flasher exclusive-ownership boundary.
