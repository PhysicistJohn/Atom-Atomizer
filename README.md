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

- Node.js 22+ and npm 11+.
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
5. A discovery, identity, unsupported-firmware, or twin boot/evidence error is visible and terminal for that admission attempt. It never activates a test double or synthetic replacement.

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

Both AI paths use exactly `gpt-realtime-2.1-mini`:

| Path | Transport | Modalities |
|---|---|---|
| Voice | Realtime API over WebRTC | Audio, image context, function tools |
| Text | Realtime API over trusted WebSocket | Text, image context, function tools |

Both paths use the identical closed tool catalog, `reasoning.effort: high`, and no model/API/transport fallback. Voice uses Ballad and server VAD threshold `0.95`; Chromium requests echo cancellation, noise suppression, and automatic gain control.

Every sent Realtime session setting is recursively compared with the API’s `session.updated` echo. Sent values, returned values, mismatches, and server-only defaults are emitted to the console. A mismatch or acknowledgement timeout terminates the session.

Atom’s application surface is contract version 4:

- Every declared UI hook resolves to exactly one preferred typed tool, risk class, evidence projection, executor, and guarantee.
- The same validator, policy table, action-time approval, and executor serve voice and text.
- App screenshots are treated as untrusted image data.
- Coordinate actions are confined to the Atomizer window and fail closed on high-impact DOM targets.
- RF-output enable and general firmware-screen touch require immediate human approval.
- Firmware status, pinned download, and DFU detection are first-class tools; preflight attestations and the one-shot flash control are explicit local human-only exclusions.
- Tool loops are bounded to eight operations.
- Unknown tools, malformed arguments, missing evidence, duplicate Realtime calls, and unavailable conversations fail visibly without retry or reroute.

## Implemented instrument surface

- Exact ZS407 USB-shell framing and serialized command scheduling.
- Unique-device physical auto-admission with a closed shipped/OEM firmware registry and executable-twin admission only when no exact device exists.
- Analyzer configuration, readback, single/continuous spectrum acquisition, raw/text transfers, and zero span.
- Device-observed `scanraw` offset readback and provenance-preserving Q5 decoding.
- Spectrum, coherent waterfall, channel power/PSD/ACP/ACLR/OBW, and detected-envelope STFT.
- Four host traces: Clear/Write, Max Hold, Min Hold, linear-power Average, View, Blank, and reset.
- Eight markers: independently off/on, fixed/peak tracking, trace assignment, peak/min/next search, delta, and dBm/Hz.
- Explicit reference level, dB/div, and evidence-backed auto scale.
- Persistent signal detection and bounded spectral/envelope classification with explicit unknown results.
- Generator frequency, level, path, AM/FM configuration, forced-off apply, RF state, and governed enable.
- Exact 480×320 RGB565 screen capture, diagnostics, and governed touch.
- Provenance-preserving CSV/JSON export.
- Sandboxed Electron renderer, allow-listed preload IPC, app-scoped computer harness, and exact-model Atom gateway.
- Content-addressed OEM updater with automatic download, private cache, audited preflight, exact STM32 DFU admission, one-shot write semantics, post-reboot identity verification, and human-only flash authority.

## Safety and evidence boundary

Generator configuration and physical output do not have dependable firmware readback. They remain labeled `commanded`; uncertain transport loss makes RF state `unknown`. Software is not a hardware interlock.

The delivered physical ZS407 is admitted, has passed initial receive-only text/raw sweep, diagnostics, and exact LCD-byte validation, and completed one guarded update to the pinned `c979386` OEM firmware with post-reboot identity verification. This is not RF calibration or complete Gate B qualification; timing matrices, destructive update-fault cases, cable-loss cases, touch, high-frequency behavior, generator behavior, and metrology remain open. See [the characterization record](./docs/PHYSICAL_ZS407_CHARACTERIZATION.md).

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
npm run check:firmware-twin
npm run release:trio
```

`check:trio-contract` requires byte-identical v2 manifests and reconciles Atomizer, physical/OEM firmware evidence, Firmware bridge, and SignalLab contract versions. `check:firmware-twin` boots Renode, checks the exact ready declaration, runs a real firmware sweep, captures the LCD, and verifies generator output returns off.

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
