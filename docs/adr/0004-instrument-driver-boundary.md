# ADR 0004: Instrument drivers are the Atomizer device boundary

- Status: accepted
- Date: 2026-07-14

## Context

Atomizer originally composed `TinySaDeviceService` directly in Electron main. That made the physical ZS407 protocol, application startup, and operator UI one implicit device contract. It also encouraged a synthetic source to masquerade as a serial port or firmware device. SignalLab is now a live high-level measurement source. A future NeptuneSDR integration would add a materially different acquisition surface, including complex I/Q. The application needs one boundary that admits present and future sources without erasing what each one can honestly prove.

## Decision

Atomizer interacts with measurement sources only through a statically registered `InstrumentDriver`. A driver owns discovery, connection, capability declaration, configuration, acquisition, optional features, source-specific protocol adaptation, and safe disconnect for one or more explicit source kinds.

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

Electron main owns the registry, manager, startup preference, IPC adapter, and child-process lifetime. The sandboxed renderer receives only `AtomizerInstrumentApiV1`. It receives runtime-validated candidate descriptors, capabilities, status, and measurement values, never serial or child-process handles or a generic IPC primitive.

## Pre-session connection ownership is explicit

Connection ownership changes through explicit handoff phases:

- From the first opened transport, spawned process, or other live resource until `connect()` returns a session candidate, the selected `InstrumentDriver` owns a pre-session connection lease.
- While validating that returned object, `InstrumentManager` owns a provisional rejected-session teardown lease. If validation and its first disconnect both fail, the manager retains a safely captured callable disconnect, publishes no session, blocks reconnect, and retries this teardown before any driver pending-connection cleanup. If no callable can be captured (including a throwing accessor), the manager retains only a cleanup barrier and delegates teardown to the required driver hook; it never stores an impossible closure that could permanently prevent aggregate cleanup.
- After admission, `InstrumentManager` owns teardown through that session. A failed admitted-session disconnect retains the session and may not be bypassed by a lower-level cleanup hook.
- Every driver must implement idempotent `cleanupPendingConnection()`. The registry rejects a driver that omits it. The hook must retain and retry every resource for which close/exit was not confirmed; reconnect is blocked while such a lease remains.
- Public `InstrumentManager.disconnect()` is the atomic aggregate teardown. It first disconnects the admitted session, then retries any manager-owned rejected-session lease, then invokes pending-connection cleanup on every statically registered driver. It attempts every registered driver cleanup even if another pending cleanup fails. A failure remains visible and the next disconnect/quit retries the same order.
- Electron's before-quit gate remains intercepted until that compound manager teardown succeeds. Synchronous `dispose()` is not a substitute for confirmed asynchronous connection cleanup.

Today `tinysa-zs407` forwards the required hook to `TinySaDeviceService`, which retains its scheduler, transport, and acknowledged RF-off teardown state across a failed connect/close. `signal-lab` retains either its boot-process lease or its unadmitted bridge client until child exit is confirmed. Thus the registry aggregate covers both current drivers; it is not a TinySA-only application callback.

This rule is mandatory for every future resource-owning driver. Registering NeptuneSDR, for example, requires its driver to retain and clean any USB/network/native-library resource opened before session admission and to participate automatically in the manager's aggregate disconnect and quit gate. The current TinySA and SignalLab hooks do not, and cannot be interpreted to, cover NeptuneSDR or any other later driver. Its composition tests must force failure before session return, failure of the first cleanup attempt, and success of a later disconnect/quit retry without leaking the resource or bypassing an admitted session.

## Source identity is not flattened

Candidate descriptors are a strict discriminated union:

- `serial-port` may carry USB/serial evidence;
- `tinysa-firmware-twin` carries executable-firmware provenance and explicitly states that USB transactions are not modeled;
- `signal-lab` carries only a SignalLab-owned synthetic source identifier; and
- any future NeptuneSDR source kind must define its own identity and provenance instead of borrowing TinySA fields.

SignalLab is a high-level measurement producer. Its driver launches the separately built, versioned NDJSON bridge and maps only admitted scalar spectrum and detected-power results. It is never a `ByteTransport`, never receives TinySA shell commands, and never claims a USB identity, firmware version, RF generator, display, touch surface, or complex-I/Q capability.

TinySA's driver is the sole adapter allowed to know the ZS407 shell, USB admission, executable-twin bridge, firmware identity, screen/touch behavior, or generator safety semantics. The existing low-level TinySA service remains internal to that driver.

Physical serial discovery admits only exact `0483:5740` endpoints and bounds enumeration, open, and close. A handle returned after open timeout is closed as an orphan; uncertain close blocks later writes. Unrelated endpoint bytes never enter a TinySA session.

Unknown but syntactically valid physical firmware revisions may be warning-admitted only as `custom-unqualified`, without invented source provenance or hardware/RF qualification. Operational compatibility never grants firmware-installation authority. Standalone `TinySA_Flasher` owns OEM and custom artifact admission and physical update transactions. Its active interface catalog v3 retains active application contract v2 (`deviceContractVersion: 2`); interface catalog v2 and legacy application contract v1 are frozen.

## Default selection

Main process persists a strict `{driverId, candidateKind?}` startup preference. With no persisted choice, the factory default is `signal-lab`. A corrupt preference, failed preferred driver, unavailable preferred source, or ambiguous preferred match is visible and does not fall through to another driver. Connecting one candidate does not silently rewrite the default; a separate explicit operator preference action does.

This is a preference, not an availability heuristic. Connecting a physical TinySA must never silently replace SignalLab, and a failed SignalLab bridge must never silently activate hardware or the firmware twin.

## Admission and retention ceilings are part of the contract

Driver neutrality does not authorize unbounded data. Instrument contract v1 exports one absolute limit table for scalar vectors, complete I/Q buffers, screen geometry and bytes, discovery collections, capability collections, profiles, diagnostics, strings, frequency, duration, power, and sequence values. These are protocol ceilings rather than claims about any current device. Every driver result is parsed before it can replace discovery state, session state, evidence, or IPC output. A future NeptuneSDR driver must fit inside these v1 ceilings or introduce an explicitly versioned acquisition contract; advertising a larger value is not implicit permission to allocate it.

Admission is independently bounded at each asynchronous ownership layer:

- the renderer admits one compound instrument transaction and one remote gesture, and continuous measurements use a bounded active/pending projection path;
- Electron main shares one 32-operation pending cap across all privileged instrument, file, AI, and computer handlers;
- `AtomizerInstrumentHost` and `InstrumentManager` each admit at most 64 normal pending operations and reserve one coalesced RF-safe teardown slot;
- the TinySA command scheduler admits at most 64 active-plus-queued commands in addition to its byte-buffer ceiling; and
- SignalLab bridge input pauses at 33 total reply obligations, with malformed, duplicate, oversized, overloaded, and final unterminated lines charged to the same lifetime and backpressure budgets.

Overflow is an explicit failure, never a retry, fallback, hidden queue, or reason to skip output-off/disconnect. The separately reserved teardown slots exist only for idempotently coalesced RF-safe cleanup. Text sweep export v1 admits at most 100,000 points and emits at most 8 MiB after complete strict provenance/vector validation. Development-launcher diagnostics retain one 4 MiB log plus one bounded rotation and truncate any single process-output append above 64 KiB.

## Capability growth and NeptuneSDR

The base contract contains common acquisition variants—swept scalar spectrum, uniformly sampled detected power, and a reserved complete single-buffer complex-I/Q shape capped at 64 MiB—and narrowly typed optional features. Continuous complex-IQ acquisition is rejected; chunking, continuation, backpressure, or long-lived streaming requires a new contract version. Current drivers advertise only the variants, ranges, and formats they truthfully provide. Neither SignalLab nor `tinysa-zs407` claims complex I/Q. The UI and agent surface derive availability from those declarations.

New common semantics require a versioned contract addition with manager validation and at least two credible consumers; they are not placed in an untyped options bag. Truly source-specific operations use a driver-owned, separately versioned extension and remain unavailable to other drivers. NeptuneSDR is not registered or supported today; adding it requires a distinct driver/source identity, truthful capabilities and provenance, consumers, contract tests, pre-session lease cleanup through the required driver hook, and a coordinated trio-contract revision.

## Consequences

- Adding a source is a registry/composition change plus one driver, not a rewrite of Atomizer's lifecycle.
- A new driver cannot enter the trusted registry without an explicit pre-session cleanup lifecycle; existing driver cleanup never implicitly covers its resources.
- Source failures and evidence remain attributable to their owner.
- Synthetic measurements can exercise Atomizer's real detection and classification path without becoming classifier ground truth or fake hardware evidence.
- Generic acquisition configuration cannot silently discard requested source-specific controls; an adapter must either implement, explicitly translate, or reject them.
- Driver, manager, IPC, and producer contracts are versioned and tested independently, with real producer/consumer interoperation required for a SignalLab release.
- Release regenerates the deterministic Bayesian classifier model and requires byte identity with both checked-in generated assets; validating a stale but internally consistent asset is insufficient.
- Trio composition v4 records the active SignalLab measurement edge, selectable TinySA physical/twin sources, factory-default/no-fallback rule, reserved SignalLab stimulus edge, and TinySA_Flasher's active interface catalog v3/application contract v2 plus frozen interface catalog v2/legacy application contract v1 ownership boundary.
