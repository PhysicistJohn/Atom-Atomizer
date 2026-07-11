# tinySA Ultra+ ZS407 Electron Controller — Research and Delivery Contract

Status: proposed plan, 2026-07-10

## Product outcome

Build a cross-platform desktop application that connects to one tinySA Ultra+ ZS407 over its normal USB cable and makes the computer the primary user interface for the instrument. The application will configure spectrum-analyzer and signal-generator modes, acquire and visualize measurements, reproduce the device screen, operate its touch UI remotely, save/export sessions, and reconnect safely after cable or device interruptions.

The analysis layer is extensible. Initial custom modes are Signal Detection (adaptive/absolute thresholding, segmentation, tracking, and alerts) and Waveform Classification (validated local model inference with confidence, provenance, ranked candidates, and explicit unknown/open-set behavior).

“Full control” means every function exposed by the installed tinySA firmware through its USB console, including the explicit remote-screen/touch surface. It does not mean adding hardware capabilities, guaranteeing undocumented commands across firmware releases, or initially programming firmware in DFU mode.

## Research conclusions

- Normal operation uses USB CDC/ACM serial (the operating system presents a COM or `/dev/tty*` port). DFU is a separate firmware-update mode.
- The console defaults to 115200 baud and accepts newline-terminated text commands. Responses are command-dependent and end at the `ch>` prompt; some operations return binary frames.
- The documented surface includes sweep configuration and acquisition (`sweep`, `scan`, `hop`, `data`, `frequencies`), analyzer controls (RBW, attenuation, LNA/LNA2, AGC, trigger, spur handling, traces, markers), generator controls (mode, frequency, level, modulation, sweep, output), presets/configuration, battery/status/info, SD-card operations, screen capture, refresh frames, touch/release, and menu activation.
- `capture`/`bulk` responses are binary RGB565 images. Documentation is inconsistent across models about screen dimensions, so dimensions and frame format must be discovered/validated on the ZS407 rather than hard-coded from older tinySA documentation.
- The firmware performs limited validation. Some commands are mode- and model-dependent. The host must validate values and sequence state transitions before sending them.
- A command and a refresh stream cannot safely share an uncoordinated reader. The transport needs a single serialized command queue and a byte-level parser that can switch among prompt-delimited text, fixed/declared binary payloads, and unsolicited refresh frames.
- Electron can use either Web Serial or the Node `serialport` package. The proposed production route is `serialport` in Electron's main process: it gives deterministic enumeration/reconnect behavior and a mock binding for tests. Only narrow, typed IPC methods are exposed to the sandboxed renderer.
- Existing Python implementations are useful behavioral references, but should not be copied into the product without a license review. The official firmware and the prominent unofficial Python API are GPL-licensed; this project should implement its own adapter from public protocol documentation and captured device behavior.

## Architecture contract

```text
React renderer (plots, controls, sessions)
        |
typed, allow-listed Electron IPC
        |
Device service (state machine, validation, safety policy)
        |
Protocol codec (command queue, prompt/text/binary parsers)
        |
Serial transport (enumeration, open/close, reconnect)
        |
USB CDC serial — tinySA Ultra+ ZS407
```

The renderer never receives arbitrary Node, serial, or IPC access. Electron runs with context isolation and renderer sandboxing enabled. The main process owns the port and all device state.

Suggested monorepo packages:

- `apps/desktop`: Electron main/preload and React renderer.
- `packages/contracts`: serializable TypeScript request, event, capability, error, and measurement types.
- `packages/tinysa`: transport-independent device service and protocol codecs.
- `packages/test-device`: deterministic fake serial instrument and recorded transcripts.

## Public application API (v1)

The preload bridge exposes one versioned object, not raw command execution:

```ts
interface TinySaApiV1 {
  listDevices(): Promise<PortCandidate[]>;
  connect(request: ConnectRequest): Promise<DeviceSnapshot>;
  disconnect(): Promise<void>;
  getSnapshot(): Promise<DeviceSnapshot>;
  configureAnalyzer(request: AnalyzerConfig): Promise<DeviceSnapshot>;
  acquireSweep(request?: AcquireRequest): Promise<Sweep>;
  startStreaming(request: StreamRequest): Promise<void>;
  stopStreaming(): Promise<void>;
  configureGenerator(request: GeneratorConfig): Promise<DeviceSnapshot>;
  setGeneratorOutput(enabled: boolean): Promise<DeviceSnapshot>;
  captureScreen(): Promise<ScreenFrame>;
  touch(point: { x: number; y: number }): Promise<void>;
  releaseTouch(): Promise<void>;
  invokeCapability(request: CapabilityRequest): Promise<CapabilityResult>;
  subscribe(listener: (event: DeviceEvent) => void): () => void;
}
```

There will be no user-facing raw console in v1. A developer-only console may be enabled by a build flag, with destructive commands denied by default.

Core contract rules:

- All frequencies are integer Hz, durations integer microseconds, and levels numeric dBm/dB. Formatting suffixes exist only inside the protocol adapter.
- Every request has a timeout, operation ID, and typed result or typed error.
- Exactly one command owns the serial response parser at a time.
- A `Sweep` contains requested and actual start/stop frequencies, frequency bins, power values, units, timestamp, device/firmware identity, and the effective settings used.
- Device capabilities come from model, hardware version, firmware version, `help`, and safe probes. UI controls are capability-driven, not assumed from “Ultra+”.
- Disconnect rejects in-flight work, clears stale state, emits an event, and starts bounded reconnect only when the user enabled it.
- Configuration changes are verified by a readback/status command where firmware supports one. Otherwise the snapshot marks the value as `commanded`, not `verified`.

## Safety contract

- RF generator output always defaults off on app startup and connection. Enabling it requires an explicit visible action and persistent on-screen indicator.
- App disconnect/quit attempts `output off`; because cable loss can prevent delivery, the UI must never imply this is a hardware interlock.
- Analyzer ranges are validated against the discovered ZS407 mode/capabilities. The UI prominently states the documented input limits; software cannot protect the RF input from excess power or DC.
- Destructive or calibration-affecting commands (`clearconfig`, calibration/offset writes, reset/restart, SD delete, DFU entry) are excluded from the normal API until separately designed with confirmations and recovery tests.
- Switching analyzer/generator modes stops streaming first and follows an explicit state-machine transition.
- No silent firmware update. DFU support is a later, separately accepted workstream with signed/verified image provenance and recovery documentation.

## Delivery milestones and acceptance

### M0 — hardware protocol characterization

Deliver a probe CLI, command transcripts, captured binary fixtures, and a ZS407 capability matrix for the exact shipped firmware.

Acceptance: on macOS, Windows, and Linux where available, identify the device; run `info`, `version`, `help`, and `status`; acquire repeated sweeps; decode a screen capture; exercise touch/release; unplug during every operation without hanging. Unknown bytes are preserved in diagnostic logs. This milestone begins when the physical unit arrives and gates final protocol commitments.

### M1 — protocol SDK and simulator

Deliver the contracts package, serial transport, command scheduler, parsers, state machine, fake device, fixtures, and structured diagnostic logging.

Acceptance: unit tests cover fragmented/coalesced reads, prompt-like bytes inside binary frames, timeouts, cancellation, malformed frames, disconnect/reconnect, and mode conflicts. Integration tests run without hardware in CI. No renderer dependency exists in the SDK.

### M2 — analyzer MVP

Deliver connection UX, device/firmware display, analyzer configuration, single and continuous sweeps, live trace plot, markers/peak search, pause/resume, screenshot/remote touch, and CSV/JSON/PNG export.

Acceptance: a 30-minute continuous run has no parser desynchronization or unbounded memory growth; displayed/exported bins match captured device results; reconnection restores UI coherently but does not silently reapply unsafe state.

### M3 — complete operational control

Deliver all safe, verified ZS407 analyzer controls, signal generator controls, modulation/sweeps, presets, supported measurements, SD browsing/read, session recording, waterfall, preferences, and keyboard-accessible UI.

Acceptance: every capability in the M0 matrix is marked implemented, intentionally excluded, or firmware-inaccessible with evidence. Remote screen/touch is a separately selected, tested control surface for firmware UI functions without a stable typed command; it is never entered automatically after a typed-command failure. Generator-output safety tests pass.

### M4 — packaging and release

Deliver signed/notarized installers as applicable, auto-update policy, user guide, troubleshooting/exportable diagnostics, licenses/SBOM, and platform CI artifacts.

Acceptance: clean-machine install/connect/sweep tests pass on the supported OS matrix; native serial dependencies are rebuilt for the packaged Electron ABI; upgrades preserve user data; uninstall and crash recovery are documented.

### Optional M5 — DFU firmware management

This is out of v1 scope. It requires a separate threat/recovery design, platform driver tests, firmware authenticity rules, power-loss testing, and explicit acceptance because failure can leave the instrument needing manual recovery.

## Initial product scope

Target one locally attached genuine tinySA Ultra+ ZS407. Support macOS, Windows, and Linux, subject to hands-on platform verification. Store sessions locally; no account, cloud service, telemetry, network remote control, or multi-device orchestration in v1. Use TypeScript, Electron, React, and a plotting library selected by a sweep/waterfall performance spike.

## Decisions to resolve during M0

1. Exact USB VID/PID, serial-number behavior, port naming, and whether clones share identifiers.
2. Exact ZS407 capture and refresh frame dimensions, byte order, and refresh reliability.
3. Prompt/echo behavior, line endings, maximum response sizes, and safe timeouts per command.
4. Which settings have reliable readback and which require app-maintained commanded state.
5. Maximum sustainable sweep/refresh rate and whether measurement and screen streaming can coexist.
6. Firmware-specific generator command ranges and behavior above 900 MHz.
7. Supported OS versions and whether Linux udev guidance is required.
8. Project license and whether any GPL code will be linked or merely treated as a behavioral reference.

## Definition of done

The project is done when the capability matrix is closed; a user can install the app, connect the ZS407, operate every accepted analyzer and generator function without touching the unit, capture/export reproducible measurements, recover cleanly from disconnects and application restarts, and understand every excluded or firmware-limited function. Automated protocol tests, hardware smoke tests, safety behavior, documentation, and packaged installers are part of the product—not follow-up work.

## Sources

- Official tinySA USB interface: https://tinysa.org/wiki/pmwiki.php?n=Main.USBInterface
- Official PC control and USB modes: https://tinysa.org/wiki/pmwiki.php?n=Main.PCSW
- Official ZS407 model comparison: https://tinysa.org/wiki/pmwiki.php?n=TinySA4.Comparison
- Official Ultra/Ultra+ specification: https://tinysa.org/wiki/pmwiki.php?n=TinySA4.Specification
- Official Ultra/Ultra+ menu tree: https://tinysa.org/wiki/pmwiki.php?n=TinySA4.MenuTree
- Official firmware repository: https://github.com/erikkaashoek/tinySA
- Unofficial Python API and behavioral examples: https://github.com/LC-Linkous/tinySA_python
- Electron context isolation: https://www.electronjs.org/docs/latest/tutorial/context-isolation
- Electron process sandboxing: https://www.electronjs.org/docs/latest/tutorial/sandbox
- Electron device/serial access: https://www.electronjs.org/docs/latest/tutorial/devices
- Node SerialPort API and mock binding: https://serialport.io/docs/api-serialport/
