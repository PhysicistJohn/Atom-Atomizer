# TinySA Atomizer

TinySA Atomizer is an AI-native Electron control plane for the tinySA Ultra+ ZS407. It owns the instrument through USB CDC, preserves measurement provenance, exposes every accepted operation through a typed API, and gives the same governed surface to Atom, its native voice and tool-using RF agent.

The repository is executable today with a byte-level ZS407 simulator. Its host protocol is derived from the sibling firmware checkout at commit `c97938697b6c7485e7cab50bca9af76996b7d671`; the ordered physical unit is still required to qualify RF accuracy, shipped firmware variance, timing, and cable-loss behavior.

## Run

Requirements: Node.js 22+ and npm 11+.

```bash
npm install
npm run check
TINYSA_SIMULATOR=1 npm run dev
```

Without `TINYSA_SIMULATOR=1`, Atomizer enumerates OS serial devices and accepts a production session only after the console identifies as a ZS407 and exposes the required command set. There is no raw-console or legacy-command fallback.

If no exact ZS407 USB identity is present at startup, Atomizer auto-attaches its synthesized ZS407 and opens the compact **Atom Signal Lab** companion window. It immediately starts a paced synthetic replay with seeded AWGN or correlated Rayleigh fading, receiver ripple, sweep evolution, and stable low-level spurs. Its CW, AM, FM, GSM normal-burst, LTE E-TM1.1, 5G NR TM1.1, and Wi-Fi 6 HE SU controls change the live byte stream and analyzer range. The demo is visibly simulated and never substitutes for a failed physical-device operation. Standards-derived profiles are spectrum/time projections, not bit-exact or conformance-validated I/Q.

To activate Atom, place `OPENAI_KEY` in `.env`. The key is read only by Electron main. Voice uses the unified Realtime WebRTC flow; text, tools, image input, and application-scoped computer operation use a trusted Realtime WebSocket. Both are locked to exactly `gpt-realtime-2.1-mini`, `reasoning.effort: high`, voice `ballad`, and server VAD threshold `0.95`. A model, API, transport, configuration, or tool failure is surfaced and stops the operation.

## Implemented vertical slice

- Exact USB shell correlation: CR commands, echoed command, CRLF text, exact `ch> ` prompt, 47-character limit.
- Stateful ZS407 byte simulator with fragmented delivery, boot banner, text/raw sweeps, zero span, diagnostics, RGB565 screen, touch, and generator commands.
- Automatic companion Signal Lab with seven live waveform profiles, seeded AWGN/Rayleigh replay, explicit standards qualification, and the same production byte protocol.
- Fail-closed serialized command scheduler and typed device state machine.
- Analyzer configuration with readback verification, 20–450 points, text/raw acquisition, RBW, attenuation, detector, spur, LNA, trigger, and sweep timing.
- Single and continuous spectrum acquisition with bounded 50-sweep in-memory history and provenance-preserving CSV/JSON export.
- Four simultaneous host-derived traces with Clear/Write, Max Hold, Min Hold, linear-power Average, View/Freeze, Blank, per-trace reset, and persistent configuration.
- Eight trace-assignable markers with peak tracking, peak/min/next search, delta and dBm/Hz readouts, click/drag placement, plus reference-level and 1/2/5/10/20 dB/div display control.
- Robust adaptive/absolute signal detection with cross-sweep promotion, stable IDs, and release behavior.
- Experimental spectral-morphology characterization plus zero-span envelope classification; both retain explicit unknown behavior and never claim I/Q or protocol decoding.
- Generator path, level, frequency, AM/FM controls, forced-off configuration sequence, persistent RF state, and approval-gated Atom enable.
- Device workspace with firmware identity, telemetry, command diagnostics, exact 480×320 screen capture, and governed remote touch.
- Full v2 Electron IPC/preload API with runtime validation and device event subscription.
- Atom voice/text, typed tool catalog, app-only screenshots/clicks, action-time approvals, and recursive verification of every returned Realtime session setting.

## Safety and evidence boundary

Generator frequency, level, modulation, path, and physical output do not have dependable firmware readback. Atomizer labels them `commanded`; cable loss makes RF state `unknown`. Software is not a hardware interlock.

The firmware exposes analyzer harmonic paths up to a command-derived 17.9226 GHz and generator mixer output up to the same ceiling. Those limits describe addressable firmware behavior, not calibrated performance. The UI warns above the 7.3701 GHz Ultra transition until the ordered ZS407 is characterized.

Zero span is repeated detected-power measurement at one frequency. It is not I/Q and cannot establish phase or decode a waveform protocol.

## Workspace map

- `apps/desktop`: hardened Electron main/preload, v2 bridge, Atom gateway, computer harness, and React instrument UI.
- `packages/contracts`: runtime-validated device, measurement, analysis, export, safety, and API v2 types.
- `packages/tinysa`: byte transport, exact parser/scheduler, serial implementation, and ZS407 device service.
- `packages/test-device`: deterministic byte-level firmware simulator.
- `packages/analysis`: robust detection/tracking, metrics, spectral morphology, and zero-span envelope analysis.
- `packages/agent`: exact-model session config, closed tool schemas, policy, approvals, and returned-setting verification.
- `packages/waveforms`: qualified synthetic waveform catalog, AWGN/Rayleigh channel engine, spectrum projections, and zero-span fixtures.

## macOS live development app

```bash
npm run dev:install-app
```

This installs `~/Applications/TinySA Atomizer Dev.app`, binds it to this checkout, adds the Atom icon to the Dock, and launches the simulator or USB mode declared in [`tools/dev-launcher/config.json`](./tools/dev-launcher/config.json). Renderer edits use HMR. Quit and reopen the Dock app after main, preload, or shared-package changes. Launcher logs and recovery steps are in [`tools/dev-launcher/README.md`](./tools/dev-launcher/README.md).

## Normative contracts

- [Firmware protocol](./docs/FIRMWARE_PROTOCOL_CONTRACT.md)
- [Markers, traces, display, and trigger](./docs/MEASUREMENT_CONTROLS_CONTRACT.md)
- [Qualified waveform and channel replay](./docs/WAVEFORM_REPLAY_CONTRACT.md)
- [UI, UX, and custom analysis modes](./docs/UI_UX_CONTRACTS.md)
- [Atom AI, Realtime, tools, and computer use](./docs/AI_NATIVE_CONTRACTS.md)
- [Master work-package contract](./CONTRACTS.md)
- [Delivery and hardware-qualification plan](./PLAN.md)
