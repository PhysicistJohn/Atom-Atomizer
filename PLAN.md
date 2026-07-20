# Atomizer delivery plan

Status: active implementation baseline
Contract/API version: instrument API 1, TinySA protocol 3, Atom surface 9, application contract 6, trio composition 4
Updated: 2026-07-17
Physical firmware baseline: source revision `c97938697b6c7485e7cab50bca9af76996b7d671`; executable-twin release identity is pinned separately by trio composition v4

## Outcome

One local Electron application hosts explicitly selected RF instrument drivers behind `AtomizerInstrumentApiV1`, without source protocols or raw serial access in the renderer. The current `signal-lab` driver produces high-level synthetic measurements; the `tinysa-zs407` driver controls an accepted physical tinySA Ultra+ ZS407 or the pinned executable Firmware twin. The same typed application layer powers the visual UI and Atom. Measurements are reproducible and carry configuration, timing, source identity, qualification, and simulation or device evidence. Generator operations remain explicitly commanded where TinySA firmware has no readback.

“Wholly controls” does not mean pretending the host can verify what firmware cannot report. Physical RF output, generator level/frequency/path/modulation, calibration quality, input protection, and harmonic-path accuracy retain clear uncertainty boundaries.

## Current architecture

```text
operator / Atom voice / Atom text / app-only computer actions
                            |
                    React application host
                            |
             AtomizerInstrumentApiV1 preload contract
                            |
       Electron main instrument host + lifecycle manager
                            |
               static driver registry
                  /                   \
        signal-lab driver        tinysa-zs407 driver
                |                    /          \
      versioned NDJSON       verified USB    Renode bridge
      measurement bridge     physical ZS407  Firmware twin

SignalLab -- reserved future stimulus intent --> Firmware sink
```

The exact `signal-lab:default` candidate is the factory default when no owner-only preference exists. Physical ZS407 and Firmware-twin candidates remain explicit selections through `tinysa-zs407`; a missing, ambiguous, or failed preference never activates a different driver or source kind. No layer may substitute a lower layer after failure. In particular, typed command failure never falls through to physical-screen clicking, another command spelling, another transport, another model, or simulation.

## Firmware-derived facts now frozen in the TinySA driver contract

- USB CDC ACM identity is `0483:5740`, product `tinySA4`.
- Commands are printable ASCII terminated by CR, echoed exactly, and complete at `ch> ` after the echo.
- Maximum command text is 47 characters.
- Screen capture is exactly 480×320 RGB565 little-endian: 307,200 bytes.
- tinySA4 firmware defines four trace slots and eight marker slots; complete simultaneous desktop trace/marker state is host-derived and labeled rather than inferred from incomplete shell readback.
- `scan … 3` returns text frequency/power/reserved rows.
- `scanraw` returns brace-framed, marker-prefixed signed int16 Q5 values after adding the device-configurable offset reported by `zero`; the host reads, subtracts, and records that offset for every raw sweep.
- Analyzer range, points, actual RBW, attenuation, and status have query/readback paths.
- Generator configuration and physical output have no dependable readback and remain commanded/unknown.
- Zero span is detected power versus time, never I/Q.
- `mode input`/`mode output` reset state and mute output; Atomizer still commands `output off` around generator transitions.
- Remote touch can reach firmware RF controls and is therefore high impact for agentic operation.

See [docs/FIRMWARE_PROTOCOL_CONTRACT.md](./docs/FIRMWARE_PROTOCOL_CONTRACT.md) for exact framing and transactions.

## Delivery ledger

| Area | Implemented now | Remaining acceptance |
|---|---|---|
| Repository/build | npm workspaces, TypeScript, Vitest, Electron/Vite, Dock dev launcher, full check command, exact Node/npm CI matrix on macOS/Windows/Linux | signed and platform-qualified release artifacts |
| Contracts | strict `AtomizerInstrumentApiV1`, TinySA protocol v3, Atom surface v9, application contract v6, byte-identical trio composition v4, source/provenance unions, physical/OEM firmware provenance, instrument/device/sweep/detected-power/screen/diagnostics/export/analysis contracts | operation IDs and schema migrations before public file persistence |
| USB transport | serial enumeration/open/read/write/events; exact VID/PID ranking; one delivered macOS ZS407 admitted at `0483:5740` | Windows/Linux port evidence and permission guidance; multiple-device hardware exercise |
| Parser/scheduler | exact echo/prompt correlation, binary fixed-length parsing, device-observed raw-offset decoder, session-fatal timeout/desync | fuzz/property corpus; physical long-command timing |
| Protocol test double | stateful ZS407 identity, fragments, analyzer/generator, screen/touch/telemetry; test-only | scripted corrupt/truncated/unplug matrix expansion |
| Executable Firmware twin | selectable `tinysa-zs407` source; pinned Renode boot evidence; firmware-executed sweeps, RGB565 screen, touch, generator; USB explicitly unmodeled | sustained soak and platform packaging of Renode dependencies |
| SignalLab | active high-level NDJSON measurement driver; exact `signal-lab:default` factory candidate with no fallback; deterministic complete-buffer `cf32le` I/Q for all 34 closed profiles: 3 analytic laboratory envelopes and 31 standards-derived engineering envelopes that are neither packet-decodable nor conformance vectors; seeded AWGN/Rayleigh; selected profile excluded from measurement/classifier evidence; separately versioned stimulus intent | framework-generated independently validated standards assets remain future; Firmware-owned stimulus sink remains reserved-not-connected until a coordinated future trio contract activates it |
| Instrument host and TinySA service | static registry, independent discovery, persisted explicit preference, serialized lifecycle, capability/evidence validation; main-owned RF state with command-acknowledged physical and firmware-executed-twin qualification; atomic event/return measurement reconciliation; bounded exact-VID/PID serial lifecycle; TinySA-only shipped/OEM/custom revision registry, analyzer readback, text/raw sweeps, diagnostics, screen/touch and safe generator | complete physical timing, fault, touch, RF and recovery qualification matrices |
| Electron bridge | `AtomizerInstrumentApiV1` handlers, runtime validation, event subscription, export dialog, sandbox; no firmware-installation IPC | CSP hardening audit and IPC abuse suite |
| Spectrum measurements | one no-scroll shared stage selected by first-class Spectrum/Waterfall/Channel sidebar destinations with no top view tabs; live React-derived SVG trace geometry; analyzer/trigger controls; four traces; eight markers with narrow sampled-peak/local-3 dB and bounded-broad centroid/component-OBW semantics; amplitude scaling; coherent waterfall; RBW-normalized CHP/PSD/ACP/ACLR/OBW; non-rendered detected-envelope STFT API; single/continuous sweeps; 50-sweep history; CSV/JSON | complete keyboard marker workflow, limit lines/emission masks, multi-sweep harmonic orchestration, sustained physical/RF validation |
| Detection | merged Detect surface with the live spectrum, robust noise floor, threshold segmentation, stable cross-sweep tracker/release, exact-visible-sweep strongest-physical Auto targeting, and a non-scrolling detected-power status strip | captured-corpus precision/recall and alert policy |
| Classification | ranked evidence and unknown rejection in the same Detect surface, with optional qualified zero-span envelope evidence and localized model-unavailable state | labeled physical corpus and validated modulation/protocol model |
| Generator | normal/mixer path, full firmware range, AM/FM settings, output-off sequencing, global RF status | physical level/frequency/path characterization and safety test fixture |
| Device console | identity/telemetry/capability ledger, screen capture, direct touch | physical pixel endian/coordinates and touch latency |
| Export | complete provenance CSV/JSON through native save dialog | durable sessions, import/migrations, comparison and PNG |
| Firmware installation boundary | absent from Atomizer; standalone sibling `../Atom-Flasher` exclusively owns OEM/custom artifact admission, download/import verification, preflight, DFU, writing, journaling, recovery, and post-reboot identity. Its native custom-manifest picker starts in `../Atom-Firmware` when present and remembers only an admitted selection directory. Its active interface catalog v3 retains active application contract v2 (`deviceContractVersion: 2`); interface catalog v2 and legacy application contract v1 are frozen | qualify the standalone Flasher independently; preserve historical evidence here without restoring an embedded path |
| Future NeptuneSDR | no registered driver and no present hardware support claim; generic complete-buffer I/Q plus SignalLab's all-profile deterministic I/Q exercise the contract and renderer, while continuous I/Q remains rejected | add a distinct hardware source kind/driver, truthful capabilities and provenance, native-format export/configuration, contract tests, UI/Atom consumers, and a coordinated trio revision; version the contract before adding chunking, backpressure, or streaming |
| Atom | exact full model, high reasoning, Ballad, VAD 0.97, one compact loader plus response-scoped concrete tools, live API usage/TPM telemetry, live DOM control topology, screenshots, policies, contextual approvals, full setting-echo verification; no firmware-installation tools | live eval corpus, safety identifier policy, production credential storage |
| UX | neutral graphite pro-app system, shared one-value-per-row active functions, five legacy `WorkspaceId` values converging on four rendered surfaces, six visible sidebar destinations, bounded measurement overlays/control tabs with no nested view-tab bar, responsive Atom rail | minimum/scaled viewport accessibility and operator usability qualification |

## Execution gates

### Gate A: firmware-derived software baseline

Complete when contracts, parser, scheduler, simulator, device service, IPC, analysis, Atom tools, all five legacy `WorkspaceId` values, all four rendered workspace surfaces, and all six visible sidebar destinations build and pass without hardware.

Evidence:

- `npm run typecheck`
- `npm test`
- `npm run build`
- simulator walkthrough for connect, text/raw sweep, continuous stop, detection persistence, morphology result, zero span, generator-off configuration, diagnostics, screen/touch, export, and Atom tool calls

### Gate B: physical ZS407 characterization

Active. The delivered unit is admitted with exact descriptors, shipped-version/source resolution, `info`-borne ZS407 identity, complete `help`, battery/device readback, mutually consistent 101-point text/raw FM-band sweeps, a device-observed 174 dB raw offset, and an exact 307,200-byte screen frame. See `docs/PHYSICAL_ZS407_CHARACTERIZATION.md`. The remaining experiments below are still required before Gate B closes.

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

### Gate C: RF analysis qualification

Use physically captured, session-grouped data. Detection reports event precision/recall, false alarms per hour, probability versus SNR, frequency/bandwidth error, and boundary behavior. Classification separates:

- spectral morphology labels that describe observed trace shape;
- zero-span envelope labels that describe power variation;
- any later modulation/protocol model, which requires I/Q-capable reference captures or a declared power-spectrum-only domain.

A production classifier requires a frozen taxonomy, corpus license/provenance, grouped splits, open-set holdout, calibrated confidence, model hash, preprocessing ID, supported-domain statement, and reproducible metrics. Until then, results remain experimental and may return `unknown`.

### Gate D: desktop release

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

The exact model is `gpt-realtime-2.1`, which the official model catalog describes as a reasoning Realtime model with text/audio/image input and function calling. Voice uses WebRTC through `/v1/realtime/calls`; trusted text/tools/screenshots use Realtime WebSocket. Both set `reasoning.effort: high`.

Voice call creation sends only the immutable `{ type: "realtime", model: "gpt-realtime-2.1" }` bootstrap with SDP. Before enabling the muted microphone, the data channel sends and verifies the complete static session: `audio.output.voice: ballad`, `audio.input.turn_detection` as `server_vad` with threshold `0.97`, automatic response creation/interruption, `gpt-realtime-whisper` transcription, high reasoning, concise instructions, and only `load_atom_tools`. That loader selects at most eight names from the closed 51-tool registry; the following `response.create` overrides tools with only those exact concrete schemas. Text configures the same static session once and obtains current application data through typed read tools. No output-token or truncation limit is configured. Requested/applied microphone settings, sent/API-returned session settings, response usage, and server rate limits are emitted to the console and reflected in Atom's rail.

Every application capability ships with a domain contract, closed agent schema, risk class, executor through the same application host, context projection, UI activity, tests, and docs. RF enable and remote physical-screen touch require action-time approval. Computer clicks are application-only and DOM-hit-tested; every coordinate action consumes a short-lived screenshot ID, focus-sensitive input verifies the expected target, and high-impact targets are blocked.

## Near-term order

1. Keep Gate A green and visually inspect every simulator workspace at the reference and minimum window sizes.
2. Expand fault fixtures and parser fuzz/property tests.
3. Add durable versioned session persistence, sweep comparison, and import validation.
4. Add zoom and editable limit lines only after measured renderer throughput; keep waterfall, channel, the non-rendered envelope-STFT API, marker, and trace behavior green at 450 points/50 frames.
5. Continue the physical characterization matrix from the recorded receive-only baseline; do not repeat already accepted identity/raw-offset work without a regression reason.
6. Build the RF capture corpus only after hardware/session provenance is stable.
7. Freeze platform support, packaging, credential storage, and release policy after hardware Gate B.

Calibration writes, unrestricted raw console, SD deletion, cloud accounts, telemetry, remote network control, and multi-device orchestration remain excluded until separately contracted. Firmware download, DFU, flashing, acknowledgement, and recovery are absent from Atomizer and owned exclusively by the standalone sibling `../Atom-Flasher`. `docs/FIRMWARE_UPDATE_CONTRACT.md` is retained here as historical characterization and handoff evidence; silent firmware installation remains forbidden.
