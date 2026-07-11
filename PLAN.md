# TinySA Atomizer delivery plan

Status: active implementation baseline
Contract/API version: 2
Updated: 2026-07-10
Firmware evidence: sibling `TinySA_Firmware` commit `c97938697b6c7485e7cab50bca9af76996b7d671`

## Outcome

One local Electron application wholly controls every accepted tinySA Ultra+ ZS407 operation exposed by the pinned firmware, without raw serial access in the renderer. The same typed application layer powers the visual UI and Atom. Measurements are reproducible and carry configuration, actual readback, timing, source, identity, and simulation state. Generator operations remain explicitly commanded where firmware has no readback.

“Wholly controls” does not mean pretending the host can verify what firmware cannot report. Physical RF output, generator level/frequency/path/modulation, calibration quality, input protection, and harmonic-path accuracy retain clear uncertainty boundaries.

## Current architecture

```text
operator / Atom voice / Atom text / app-only computer actions
                            |
                    React application host
                            |
                  TinySaApiV2 preload contract
                            |
             Electron main validation + lifecycle
                            |
         ZS407 device state machine + safety policy
                            |
        serialized command scheduler + byte parser
                            |
           USB CDC transport or explicit simulator
```

No layer may substitute a lower layer after failure. In particular, typed command failure never falls through to physical-screen clicking, another command spelling, another transport, another model, or simulation.

## Firmware-derived facts now frozen in host v2

- USB CDC ACM identity is `0483:5740`, product `tinySA4`.
- Commands are printable ASCII terminated by CR, echoed exactly, and complete at `ch> ` after the echo.
- Maximum command text is 47 characters.
- Screen capture is exactly 480×320 RGB565 little-endian: 307,200 bytes.
- tinySA4 firmware defines four trace slots and eight marker slots; complete simultaneous desktop trace/marker state is host-derived and labeled rather than inferred from incomplete shell readback.
- `scan … 3` returns text frequency/power/reserved rows.
- `scanraw` returns brace-framed, marker-prefixed signed int16 dB×32 samples.
- Analyzer range, points, actual RBW, attenuation, and status have query/readback paths.
- Generator configuration and physical output have no dependable readback and remain commanded/unknown.
- Zero span is detected power versus time, never I/Q.
- `mode input`/`mode output` reset state and mute output; Atomizer still commands `output off` around generator transitions.
- Remote touch can reach firmware RF controls and is therefore high impact for agentic operation.

See [docs/FIRMWARE_PROTOCOL_CONTRACT.md](./docs/FIRMWARE_PROTOCOL_CONTRACT.md) for exact framing and transactions.

## Delivery ledger

| Area | Implemented now | Remaining acceptance |
|---|---|---|
| Repository/build | npm workspaces, TypeScript, Vitest, Electron/Vite, Dock dev launcher, full check command | CI OS matrix; signed release build |
| Contracts | strict API v2, device/sweep/zero-span/screen/diagnostics/export/analysis plus marker, trace, display, waveform and replay-channel contracts | operation IDs and schema migrations before public file persistence |
| USB transport | serial enumeration/open/read/write/events; exact VID/PID ranking | physical macOS/Windows/Linux port evidence and permission guidance |
| Parser/scheduler | exact echo/prompt correlation, binary fixed-length parsing, raw scan decoder, session-fatal timeout/desync | fuzz/property corpus; physical long-command timing |
| Simulator | stateful ZS407 identity, fragments, analyzer/generator, screen/touch/telemetry | scripted corrupt/truncated/unplug matrix expansion |
| Waveform engine | closed 79-profile catalog; corrected resolved-line FM projection; six GSM/EDGE normal-burst modulations; 25 Release 19 LTE E/sE/N-TMs; 41 NR-FR1/N/SBFD TMs; four Wi-Fi 6 HE PPDUs; seeded AWGN and correlated Rayleigh channels | admitted hashed I/Q assets and independent checks before any conformance-validated claim; multi-carrier ETC/NRTC orchestration |
| Demo Signal Lab | auto-attach only when no exact ZS407 is detected; continuously replay the selected waveform/channel while the companion window changes the real text/raw/zero-span byte source and recommended analyzer range | physical-device coexistence test; visual review at supported display scales |
| Device service | identity gate, capability catalog, analyzer readback, text/raw/zero-span, diagnostics, screen/touch, safe generator | physical command transcript qualification and recovery observations |
| Electron bridge | API v2 handlers, runtime validation, event subscription, export dialog, sandbox | CSP hardening audit and IPC abuse suite |
| Spectrum | advanced analyzer/trigger controls, four host-derived trace modes, eight trace-assignable markers/search/delta/noise readouts, amplitude scaling, exact plot/metrics, single/continuous sweeps, 50-sweep memory history, CSV/JSON | complete keyboard marker workflow, waterfall/limit lines, sustained physical soak |
| Detection | robust noise floor, threshold segmentation, stable cross-sweep tracker and release | captured-corpus precision/recall and alert policy |
| Classification | morphology evidence, ranked candidates, unknown rejection, zero-span envelope mode | labeled physical corpus and validated modulation/protocol model |
| Generator | normal/mixer path, full firmware range, AM/FM settings, output-off sequencing, global RF status | physical level/frequency/path characterization and safety test fixture |
| Device console | identity/telemetry/capability ledger, screen capture, direct touch | physical pixel endian/coordinates and touch latency |
| Export | complete provenance CSV/JSON through native save dialog | durable sessions, import/migrations, comparison and PNG |
| Atom | exact model, high reasoning, Ballad, VAD 0.95, voice/text, all feature hooks, screenshots, policies, approvals | live eval corpus, safety identifier policy, production credential storage |
| UX | atomic precision visual system, five live workspaces, responsive Atom rail | screenshot review at all supported scales and operator usability pass |

## Execution gates

### Gate A — firmware-derived software baseline

Complete when contracts, parser, scheduler, simulator, device service, IPC, analysis, Atom tools, and all five workspaces build and pass without hardware.

Evidence:

- `npm run typecheck`
- `npm test`
- `npm run build`
- simulator walkthrough for connect, text/raw sweep, continuous stop, detection persistence, morphology result, zero span, generator-off configuration, diagnostics, screen/touch, export, and Atom tool calls

### Gate B — ordered ZS407 characterization

Begins when the unit arrives. Record exact USB descriptors, `version`, `info`, `help`, boot behavior, and sanitized byte transcripts before changing the host profile.

Required experiments:

1. Identify on each target OS and prove candidate/path behavior.
2. Repeat every read-only query three times.
3. Acquire text and raw sweeps at 20, 64, 145, 290, and 450 points.
4. Capture screens, confirm RGB565 endian/orientation, and map corner/center touches.
5. Compare requested/read-back analyzer settings across automatic/manual RBW and attenuation.
6. Remove USB during identification, text scan, raw scan, screen capture, zero span, generator configuration, RF-on, and clean shutdown.
7. Measure sustainable sweep cadence and a 30-minute continuous run.
8. Use appropriate RF equipment and loads to characterize generator ranges; never infer physical output solely from shell success.

Any firmware variance becomes an explicit capability-profile change with fixtures and an ADR. It is not hidden behind UI conditionals.

### Gate C — RF analysis qualification

Use physically captured, session-grouped data. Detection reports event precision/recall, false alarms per hour, probability versus SNR, frequency/bandwidth error, and boundary behavior. Classification separates:

- spectral morphology labels that describe observed trace shape;
- zero-span envelope labels that describe power variation;
- any later modulation/protocol model, which requires I/Q-capable reference captures or a declared power-spectrum-only domain.

A production classifier requires a frozen taxonomy, corpus license/provenance, grouped splits, open-set holdout, calibrated confidence, model hash, preprocessing ID, supported-domain statement, and reproducible metrics. Until then, results remain experimental and may return `unknown`.

### Gate D — desktop release

Complete only after clean install/connect/sweep on frozen macOS, Windows, and Linux versions; native serial ABI packaging; RF safety cases; crash/restart behavior; dependency audit/SBOM; keyboard/accessibility review; signed/notarized packages as applicable; and user/support documentation.

## State and failure rules

- One scheduler owns all response bytes and one instrument operation is in flight.
- Continuous acquisition is serialized and stops after the current firmware operation; it never overlaps commands.
- A timeout, malformed echo/payload, unexpected prompt state, or cable loss faults the session and cancels queued work.
- Reconnect is user initiated and never restores acquisition or RF-on state.
- Previous valid measurement data stays visible after a failed new acquisition but is not relabeled as current.
- Export cancellation is an explicit `cancelled` result; write failures surface and do not pick another path.
- Physical screen control is never an automatic recovery path.
- Atom never repeats or reroutes a failed state-changing operation.

## Atom plan

The exact model is `gpt-realtime-2.1-mini`, which the official model catalog describes as a reasoning Realtime model with text/audio/image input and function calling. Voice uses WebRTC through `/v1/realtime/calls`; trusted text/tools/screenshots use Realtime WebSocket. Both set `reasoning.effort: high`.

Voice additionally fixes `audio.output.voice: ballad` and `audio.input.turn_detection` to `server_vad` with threshold `0.95`, automatic response creation, and interruption. Chromium requests echo cancellation, noise suppression, and automatic gain control. Requested/applied microphone settings and sent/API-returned Realtime session settings are emitted to the console; voice remains muted until the final `session.updated` object exactly acknowledges all sent leaves.

Every application capability ships with a domain contract, closed agent schema, risk class, executor through the same application host, context projection, UI activity, tests, and docs. RF enable and remote physical-screen touch require action-time approval. Computer clicks are application-only and DOM-hit-tested; high-impact targets are blocked.

## Near-term order

1. Keep Gate A green and visually inspect every simulator workspace at the reference and minimum window sizes.
2. Expand fault fixtures and parser fuzz/property tests.
3. Add durable versioned session persistence, sweep comparison, and import validation.
4. Add zoom, waterfall and limit lines only after measured renderer throughput; keep marker/trace behavior green at 450 points.
5. Run the physical characterization protocol immediately when the ZS407 arrives.
6. Build the RF capture corpus only after hardware/session provenance is stable.
7. Freeze platform support, packaging, credential storage, and release policy after hardware Gate B.

DFU, calibration writes, unrestricted raw console, SD deletion, cloud accounts, telemetry, remote network control, multi-device orchestration, and silent auto-update remain excluded until separately contracted.
