# TinySA Atomizer

TinySA Atomizer is an AI-native Electron control plane for the tinySA Ultra+ ZS407. It owns operator intent, physical USB orchestration, measurement projections, and Atom—the application-layer voice and tool-using RF agent.

The live system is deliberately split into three independently versioned repositories:

| Repository | Sole owner | Current edge |
|---|---|---|
| `TinySA` | Operator app, physical USB, measurement analysis, Atom policy and approvals | Physical ZS407 or Firmware twin |
| `TinySA_Firmware` | Pinned executable Renode twin and bridge | Active Atomizer producer |
| `TinySA_SignalLab` | Waveform descriptors, seeded channel models, stimulus intent | Reserved; no sink is connected yet |

The normative composition is byte-identical in all three repositories at [trio-composition-v2.json](./contracts/trio-composition-v2.json). Physical USB and the Renode monitor bridge are never represented as the same transport or evidence class.

## Run

Requirements:

- Node.js 22.23.1 and npm 10.9.8 (the versions pinned by CI).
- The sibling Firmware repository at `../TinySA_Firmware`.
- Renode and the pinned Firmware twin dependencies declared by that repository.
- `../TinySA_SignalLab` only when running the separate SignalLab application.
- `dfu-util` 0.11 only when performing a physical firmware update (`brew install dfu-util` on this development Mac).

```bash
npm install
npm run check
npm run dev
```

Startup follows one closed admission rule:

1. Complete physical USB discovery.
2. If exactly one exact ZS407 CDC candidate exists, suppress the twin and automatically connect the physical unit through the strict identity/source/command gate.
3. If multiple exact candidates exist, suppress the twin and require operator choice.
4. If no exact ZS407 exists, expose and automatically connect the executable twin from `../TinySA_Firmware`.
5. A discovery, identity, malformed-firmware, required-command, or twin boot/evidence error is visible and terminal for that admission attempt. A syntactically valid unknown physical revision is admitted only as `custom-unqualified`, with persistent warning and no invented source provenance. It never activates a test double or synthetic replacement.

The executable twin boots the pinned `lab-v0.2.0-protocol` firmware in Renode. Its sweeps, LCD framebuffer, touch behavior, and generator state come from executable firmware. Its transport is `renode-monitor-bridge`; USB transactions are explicitly not modeled.

The byte-level test device in `packages/test-device` is test-only. It is not a runtime fallback.

## SignalLab

SignalLab is now a separate application and Git repository:

```bash
npm --prefix ../TinySA_SignalLab install
npm --prefix ../TinySA_SignalLab run dev
```

It owns 79 closed visual stimulus profiles and deterministic AWGN/Rayleigh channel configuration. It does not impersonate USB hardware and is not currently connected to Atomizer or the twin. The future edge is a versioned `SignalLabStimulusIntent -> Firmware stimulus sink`; only the Firmware repository may activate that edge.

## Atom

Place `OPENAI_KEY` in `.env`. The key is read only by the trusted Electron main process and never crosses preload into the renderer.

Both AI paths use exactly `gpt-realtime-2.1`:

| Path | Transport | Modalities |
|---|---|---|
| Voice | Realtime API over WebRTC | Audio, image context, function tools |
| Text | Realtime API over trusted WebSocket | Text, image context, function tools |

Both response paths use the identical closed registry of 54 concrete tools, `reasoning.effort: high`, and no model/API/transport fallback. The persistent session contains only `load_atom_tools`; Atom selects at most eight exact names for one operation, and the next `response.create` installs only those concrete schemas. Voice uses Ballad, server VAD threshold `0.97`, and the separate `gpt-realtime-whisper` input-transcription subsystem; Chromium requests echo cancellation, noise suppression, and automatic gain control.

Realtime tool calls are executed only from completed `response.done` items. Atomizer submits every function output, then exactly one continuation response with the current response-scoped schemas, so a tool cannot race the response that requested it. User and assistant transcript deltas stream into the Atom history. Voice makes one startup connection attempt with the microphone muted; microphone and Atom speaker state are independent, color-coded local human controls. `response.done.usage` and `rate_limits.updated` drive console and rail telemetry.

Every sent Realtime session setting is recursively compared with the API’s `session.updated` echo. Sent values, returned values, mismatches, and server-only defaults are emitted to the console. A mismatch or acknowledgement timeout terminates the session.

WebRTC admission sends only the immutable exact-model bootstrap with SDP. Atom then sends the voice, reasoning, transcription, concise instruction, and compact loader configuration over the data channel and keeps the microphone disabled until the API echoes it exactly. Text configures the same static loader contract once rather than rewriting instructions or injecting mutable application state every turn. Atomizer sets no output-token cap or reduced context/truncation window; throughput comes from response-scoped schema loading, not artificial token limits.

Atom’s application surface is contract version 5:

- Every declared UI hook resolves to exactly one preferred typed tool, risk class, evidence projection, executor, and guarantee.
- The same validator, policy table, action-time approval, and executor serve voice and text.
- Every tool’s delivered parameters are generated from its execution-time Zod validator; Realtime-forbidden top-level schema combinators are absent, while cross-field invariants remain runtime-enforced and explicitly described.
- Coordinate computer actions consume a short-lived one-use screenshot ID; typing and keys require the exact focused-target identity returned by the latest screenshot or successful computer action.
- App screenshots are treated as untrusted image data.
- Coordinate actions are confined to the Atomizer window and fail closed on high-impact DOM targets.
- RF-output enable and general firmware-screen touch require immediate human approval.
- Firmware status, pinned download, and DFU detection are first-class tools; preflight attestations and the one-shot flash control are explicit local human-only exclusions.
- Tool loops are bounded to eight operations.
- Unknown tools and malformed arguments return explicit failed tool evidence for one bounded schema-grounded correction. Missing evidence, duplicate Realtime calls, unavailable conversations, and session-protocol failure stop visibly without retry or reroute.

## Implemented instrument surface

- Exact ZS407 USB-shell framing and serialized command scheduling.
- Unique-device physical auto-admission with qualified shipped/OEM provenance, warning-only custom-firmware admission, and executable-twin admission only when no exact device exists.
- Analyzer configuration, readback, single/continuous spectrum acquisition, live pause-verify-resume retuning, raw/text transfers, and zero span.
- Device-observed `scanraw` offset readback and provenance-preserving Q5 decoding.
- Spectrum, coherent waterfall, channel power/PSD/ACP/ACLR/OBW, and detected-envelope STFT.
- Four host traces (`H1..H4`): Clear/Write, Max Hold, Min Hold, linear-power Average, View, explicit Off, and reset; enabled firmware traces are separately read as provenance-bearing `D1..D4` frames and overlaid only when explicitly enabled.
- Eight markers, all off by default: independently off/on, fixed/peak tracking, trace assignment, peak/min/next search, delta, and dBm/Hz.
- Explicit reference level, dB/div, and evidence-backed auto scale.
- Persistent robust-threshold signal detection with local prominence, cross-sweep promotion, and explicit candidate/released states. Detect alone overlays active bandwidth regions and dashed channel-center lines; Spectrum remains annotation-free.
- Measurement-only SignalLab EMSO hypotheses over 79 profiles, with exact/family/unknown decisions, pinned producer provenance, open-set rejection, and no selected-state side channel.
- Classify presents live observation names such as `CW carrier`, `AM signal`, and `FM signal`; it keeps SignalLab replay provenance out of the waveform label, qualifies results as measured hypotheses, and marks positive classifications green.
- Generator frequency, level, path, AM/FM configuration, forced-off apply, RF state, and governed enable.
- Exact 480×320 RGB565 screen capture, diagnostics, and governed touch.
- Provenance-preserving CSV/JSON export.
- Sandboxed Electron renderer, allow-listed preload IPC, app-scoped computer harness, and exact-model Atom gateway.
- Content-addressed OEM updater with automatic download, private cache, audited preflight, exact STM32 DFU admission, one-shot write semantics, post-reboot identity verification, and human-only flash authority.

## Safety and evidence boundary

Generator configuration and physical output do not have dependable firmware readback. They remain labeled `commanded`; uncertain transport loss makes RF state `unknown`. Software is not a hardware interlock.

The delivered physical ZS407 has passed initial receive-only text/raw sweep, diagnostics, exact LCD-byte validation, and one guarded update to the pinned `c979386` OEM firmware with post-reboot identity verification. It was subsequently observed running custom revision `43eb0f1`, which Atomizer admitted with exact USB/command/output-off checks and explicit `custom-unqualified` provenance. This is not RF calibration or complete Gate B qualification; timing matrices, destructive update-fault cases, cable-loss cases, touch, high-frequency behavior, generator behavior, and metrology remain open. See [the characterization record](./docs/PHYSICAL_ZS407_CHARACTERIZATION.md).

Zero span is detected power versus time, not I/Q. Envelope STFT cannot establish phase, EVM, symbols, or protocol identity. Standards-derived SignalLab profiles are visual resource/timing projections unless separately backed by immutable conformance evidence.

## Release gates

Repository-local verification:

```bash
npm run check
npm --prefix ../TinySA_SignalLab run check
```

Cross-repository contract and executable-twin verification:

```bash
npm run check:trio-contract
npm run check:signal-classifier
npm run check:firmware-twin
npm run release:trio
```

`check:trio-contract` requires byte-identical v2 manifests and reconciles Atomizer, physical/OEM firmware evidence, Firmware bridge, and SignalLab contract versions. `check:signal-classifier` generates the 79-profile and open-set offline measurement corpus from SignalLab. `check:firmware-twin` boots Renode, checks the exact ready declaration, runs a real firmware sweep, captures the LCD, and verifies generator output returns off.

## Workspace map

- `apps/desktop`: Electron main/preload, React operator UI, Atom host, and app computer harness.
- `packages/contracts`: runtime-validated device, transport, measurement, safety, and API v2 types.
- `packages/tinysa`: physical serial transport, executable-twin adapter, parser, scheduler, and device service.
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

- [Trio composition](./contracts/trio-composition-v2.json)
- [Atom AI, Realtime, tools, and computer use](./docs/AI_NATIVE_CONTRACTS.md)
- [Firmware protocol](./docs/FIRMWARE_PROTOCOL_CONTRACT.md)
- [Physical ZS407 characterization](./docs/PHYSICAL_ZS407_CHARACTERIZATION.md)
- [Firmware update](./docs/FIRMWARE_UPDATE_CONTRACT.md)
- [Markers, traces, display, and trigger](./docs/MEASUREMENT_CONTROLS_CONTRACT.md)
- [Waterfall, channel measurements, OBW/ACP, and envelope STFT](./docs/ADVANCED_MEASUREMENTS_CONTRACT.md)
- [UI and UX](./docs/UI_UX_CONTRACTS.md)
- [Master work-package contract](./CONTRACTS.md)
- [Delivery and hardware-qualification plan](./PLAN.md)
