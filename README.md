# TinySA Atomizer

A secure, local-first Electron control plane for the tinySA Ultra+ ZS407. The repository currently contains the pre-hardware foundation: typed contracts, serial transport, prompt parser and command scheduler, byte-level simulator, analyzer service, signal detection, waveform-classification boundary, and a desktop vertical slice.

## Run it now

Requirements: Node.js 22+ and npm 11+.

```bash
npm install
npm run check
TINYSA_SIMULATOR=1 npm run dev
```

The simulator appears as a ZS407 and produces a repeatable 450-point trace. Without `TINYSA_SIMULATOR=1`, the app enumerates real OS serial ports. Real-device commands remain provisional until the ordered ZS407 is characterized.

To activate the native Atom copilot, copy `.env.example` to `.env` and set `OPENAI_KEY`. The key is loaded only by Electron main. Voice uses Realtime WebRTC; text, tools, and app-window computer control use one trusted Realtime WebSocket. Both are locked to `gpt-realtime-2.1-mini` with `high` reasoning effort. There is no alternate model, API, transport, alias, effort downgrade, or automatic retry path: a failure is shown and execution stops.

## Workspace map

- `apps/desktop`: hardened Electron main/preload and React instrument UI.
- `packages/contracts`: versioned units, device, measurement, safety, and analysis types.
- `packages/tinysa`: byte transport, serial implementation, scheduler/parser, and device service.
- `packages/test-device`: byte-level ZS407 simulator.
- `packages/analysis`: adaptive signal detection and waveform-classifier interface.
- `docs/adr`: architecture decisions and extension rules.

## Current safety boundary

Generator output defaults off and cannot be enabled before entering generator mode. Reconnect restoration is intentionally absent. A cable loss can make actual RF state unknowable; the production UI must display `unknown`, never falsely claim off. The app is not a hardware interlock.

## What waits for hardware

- Exact prompt, echo, timeout, abort, and error behavior.
- ZS407 binary capture/refresh framing and remote touch.
- Readback and commanded-versus-verified behavior.
- Above-900 MHz analyzer/generator mode boundaries.
- Sustainable stream rate and command/refresh arbitration.
- A labeled capture corpus and validated waveform classifier.

See [PLAN.md](./PLAN.md) and [CONTRACTS.md](./CONTRACTS.md) for the complete delivery scope.

The screen-level states, interaction rules, detection/classification quality bars, acceptance IDs, and custom-mode extension boundary are specified in [docs/UI_UX_CONTRACTS.md](./docs/UI_UX_CONTRACTS.md).

The native Atom voice/agent architecture, exact `gpt-realtime-2.1-mini` model lock, application tool catalog, app-scoped computer use, approval policy, privacy boundary, and AI evals are specified in [docs/AI_NATIVE_CONTRACTS.md](./docs/AI_NATIVE_CONTRACTS.md).
