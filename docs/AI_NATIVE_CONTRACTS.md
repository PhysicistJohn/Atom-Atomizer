# Atom AI — Native Agent, Voice, Tool, and Computer-Use Contract

Status: execution baseline  
Version: 9.0.0
Model lock: `gpt-realtime-2.1`
Reasoning lock: `high`  
Voice lock: `ballad`  
VAD lock: `server_vad`, threshold `0.97`
Input-transcription lock: `gpt-realtime-whisper`
Updated: 2026-07-14

This document is normative. “Atom” is the application-layer AI inside TinySA Atomizer. It is not a general desktop agent and not a chat feature layered over the UI. It is an alternate, fully governed control surface for the same typed instrument capabilities used by the visual application.

## 1. Exact model contract

Every response-agent path uses exactly `gpt-realtime-2.1`:

| Path | API | Purpose |
|---|---|---|
| Voice | Realtime API over WebRTC | Native speech-to-speech, interruption, conversation, function calls |
| Text agent | Realtime API over trusted WebSocket | Text reasoning, multi-step application tools, screenshot input, app-scoped computer control |

No fallback model, API, endpoint, transport, alias substitution, silent upgrade, retry route, or second reasoning model is permitted. Voice uses Realtime WebRTC; text/tools/computer use Realtime WebSocket. Any authentication, authorization, model, rate-limit, network, protocol or server failure is surfaced and execution stops. Model or transport changes require a contract change, prompt/tool regression evaluation, and explicit owner approval.

Voice input transcription is a separate, non-agent Realtime subsystem locked to
`gpt-realtime-whisper`; it does not generate Atom responses, reason, choose
tools, or substitute for the response model. Its sole output is the user's
streaming transcript. The optional transcription `delay` setting is omitted
because conversational sessions do not echo it as an acknowledged session
setting; every field Atomizer does send remains subject to exact echo
verification.

Every voice and text session sets `reasoning: { effort: "high" }`. The exact model accepted and echoed this configuration in a live WebSocket probe. Lowering effort for latency/cost or changing it dynamically requires an explicit contract and evaluation change; it is not an automatic degradation path.

The official model catalog identifies the exact model as a 128k-context reasoning Realtime model with text/audio/image input, text/audio output, and function calling. It lists only the Realtime endpoint and does not list a built-in computer tool. Every function argument is therefore untrusted and runtime-validated; computer operation uses an application-owned harness exposed as functions.

## 2. Trust architecture

```text
microphone / text
      |
sandboxed renderer  <---->  Atom visual rail
      | typed IPC                  |
trusted Electron main             | approval at point of risk
      |                            |
OpenAI gateway              application tool host
      |                            |
Realtime API                typed device + UI APIs
                                   |
                            command safety policy
                                   |
                    tinySA USB CDC or declared
                    Firmware Renode bridge
```

### 2.1 Credential boundary

- `OPENAI_KEY` is the sole credential name and is accepted only in the trusted Electron main process.
- `.env` is loaded only by main and is git-ignored.
- The credential is never placed in Vite variables, preload, renderer state, WebRTC events, logs, diagnostics, session files or exports.
- Renderer IPC can ask whether AI is configured; it cannot read, set, validate or export the key.
- Realtime uses the unified WebRTC interface: main posts SDP plus only the immutable exact-model bootstrap to `/v1/realtime/calls` with the standard key and returns only the SDP answer. The full mutable contract is enforced over the data channel before microphone capture is enabled.
- Text uses a server-side Realtime WebSocket with an authorization header. The socket and key never cross preload.
- Production credential storage must migrate from plaintext `.env` to OS keychain or an owner-approved local broker before public distribution.

### 2.2 Network boundary

Only trusted main may call OpenAI REST endpoints or open the text-agent WebSocket. Realtime voice media is carried by the renderer’s WebRTC peer after trusted session creation. No measurement data is transmitted merely because AI is configured; data is included only in an active user-initiated Atom turn/session and is minimized to the context necessary for the request.

### 2.3 Trio topology boundary

Atomizer owns operator intent, instrument selection/lifecycle, OpenAI credentials, tool policy, approvals, and orchestration. `TinySA_SignalLab` owns the active high-level synthetic measurement producer and the separate future stimulus intent. `TinySA_Firmware` owns the executable twin and that future intent's sink. Atom reads topology when source identity or composition is material and preserves these distinctions:

| Source | Driver / transport | Qualification | USB status |
|---|---|---|---|
| SignalLab | `signal-lab` / `signal-lab-measurement-bridge` | `synthetic-visual-projection`; no RF, firmware, generator, screen, touch, or complex I/Q claim | Not a USB source |
| Physical ZS407 | `tinysa-zs407` / `usb-cdc-acm` | `device-observed` after exact identity; custom firmware may remain warning-admitted and unqualified | Verified only after exact identity; real USB transactions |
| Executable twin | `tinysa-zs407` / `renode-monitor-bridge` | `firmware-executed-twin` | Not verified; USB transactions not modeled |
| Protocol test double | test-only / `protocol-test-double` | Test evidence only | Not verified or modeled |

The byte-identical trio composition v4 manifest is normative. With no persisted preference, SignalLab is the factory default; a failed or ambiguous preference never falls back to a different source. Atom may observe and operate only capabilities declared by the active `AtomizerInstrumentApiV1` session. SignalLab's selected profile is status/capability state and cannot become detector or classifier evidence. The active SignalLab→Atomizer measurement edge is distinct from the SignalLab→Firmware stimulus edge, which remains `reserved-not-connected`; Atom cannot activate that edge or describe the twin as USB.

NeptuneSDR is a future driver and contract-evolution target, not a currently registered or supported instrument. Atom must not offer SDR or complex-I/Q tools until a versioned source identity, truthful capabilities/provenance, manager validation, consumer behavior, and coordinated composition contract exist.

## 3. Atom identity and behavior

Atom serves two audiences without pretending they have the same needs:

- **RF hobbyist:** explains concepts, suggests safe starting settings, narrates what the trace may indicate, distinguishes instrument artifacts from evidence, teaches next experiments.
- **RF engineer:** moves quickly through precise ranges/settings, summarizes measurements, manages repeatable workflows, surfaces provenance/limitations, and avoids elementary prose unless asked.

Atom must:

- Read the narrowest current-state tool only when a claim or operation actually depends on it; never fetch all state reflexively.
- Prefer native typed tools over describing clicks or using computer control.
- Use integer Hz and explicit dB/dBm units in tool calls.
- Distinguish requested, commanded, verified, stale, simulated and unknown values.
- Never invent a waveform classification or imply regulatory-grade accuracy.
- Never describe software as an RF interlock.
- Keep initial spoken responses concise and offer deeper analysis.
- Lead with the answer, make every word earn its place, omit tool narration, and expand only when asked or when safety, uncertainty, or provenance requires it.
- Explain tool intent before high-impact operations.

## 4. Agent lifecycle

```text
unconfigured -> idle -> connecting -> listening <-> thinking <-> speaking
                  ^          |            |             |
                  +----------+------------+-------------+
                             +----------> error
```

| State | Visual obligation | Input behavior |
|---|---|---|
| Unconfigured | Setup copy, model identity, disabled composer/mic | No API call |
| Idle | Suggested RF workflows, composer and mic available | Text or voice starts turn |
| Connecting | Voice animation and cancel | Duplicate starts ignored |
| Listening | Clear live microphone state; stop control | User speech can interrupt model |
| Thinking | Show that Atom is working with the instrument | Voice interruption/cancel available |
| Speaking | Live visual voice state; transcript accumulation | User barge-in supported by session VAD |
| Error | Typed actionable cause; preserve transcript | Retry/close; no automatic risky retry |

## 5. Realtime voice contract

### 5.1 Session creation

1. When `OPENAI_KEY` is configured, renderer makes one automatic startup connection attempt with microphone state already muted. Failure is visible and is not retried automatically.
2. Renderer requests microphone permission and creates one `RTCPeerConnection`; the local audio track is disabled before it can send audio.
3. Renderer adds one microphone track and one `oai-events` data channel.
4. Renderer sends SDP through allow-listed IPC.
5. Main validates size/shape and calls `/v1/realtime/calls` with only `{ "type": "realtime", "model": "gpt-realtime-2.1" }`. Model identity is immutable; no alias or default chooses it.
6. Main returns SDP only; renderer sets the remote answer.
7. The microphone track remains disabled while the first `session.created` event is compared with the complete intended contract. API-supplied defaults and initial differences are logged separately; they are not treated as final configuration.
8. Renderer sends `high` reasoning, Ballad, `gpt-realtime-whisper`, server VAD threshold `0.97`, concise static Atom instructions, and only the closed `load_atom_tools` definition through `session.update`, then starts a bounded ten-second acknowledgement timer.
9. Every `session.updated` echo is recursively compared. At least one exact acknowledgement must arrive before the timer expires; any final mismatch or timeout is emitted to the console, shown in Atom, and terminates the voice session.
10. Only after an exact acknowledgement does the renderer enter Listening. The microphone remains muted until the local human unmutes it; remote Ballad audio auto-plays unless the independent speaker control is muted.

### 5.2 Voice behavior

- Server voice-activity detection uses activation threshold `0.97`, creates responses, and allows interruption.
- Chromium is required to apply echo cancellation, noise suppression and automatic gain control. Requested and applied `MediaStreamTrack` settings are emitted together; a missing or mismatched setting terminates startup rather than silently degrading voice capture.
- A renderer-global ownership lease and synchronous startup token permit only one peer/session construction at a time, covering auto-connect/manual-connect, React teardown, and in-flight media-permission races. A canceled asynchronous start cannot resurrect a peer. A second remote audio track or distinct stream terminates the session rather than producing double playback; one connected session still preserves normal VAD barge-in.
- `session.created` and every `session.updated` check emit every sent leaf, the full returned session, and every server-only/default setting in a collapsed console group.
- Mic, peer connection, data channel and media tracks close on user stop, window close, session failure or component teardown.
- User input-transcription deltas and assistant audio-transcript deltas stream into the same Atom history used by text; completion finalizes the existing message rather than appending a duplicate.
- Input-transcription failure is shown and terminates the voice session; it is never replaced with guessed text or another model.
- Partial assistant transcripts are not persisted as complete messages.
- Function calls are harvested only from completed `response.done` output. They go through the identical validator, policy and approval path as text-agent calls; every function output is submitted before exactly one continuation `response.create`.
- A user response starts with only `load_atom_tools`. A valid loader call is the sole call in its response and selects one to eight names from the closed 50-tool enum. The continuation uses a one-response `tools` override containing the loader plus only those exact concrete schemas. A new speech turn returns to the compact session surface.
- Invalid function names/JSON/arguments become explicit failed `function_call_output` results so Atom may make one schema-grounded correction inside the bounded chain; they do not masquerade as host success or tear down an otherwise healthy voice transport.
- Voice function chains are limited to eight application calls per user speech turn; the non-executing loader does not consume that operation allowance. Duplicate call IDs fail the session.
- Tool output is returned as `function_call_output`; screenshots are additionally returned as explicitly untrusted Realtime image input before Atom continues.
- Every `response.done.usage` and `rate_limits.updated` event is parsed into exact token/cached-token and request/token-bucket telemetry, emitted to the console, and projected into Atom's rail.
- The app never records raw microphone audio locally in v1.

## 6. Text agent transport contract

### 6.1 Turn protocol

1. Renderer submits a prompt, or completed function outputs plus the exact response-scoped tool-name set, through named IPC. Mutable application state is never concatenated into instructions.
2. Main opens or continues the sole trusted text-only Realtime WebSocket using the exact model.
3. Once per socket, main sends `session.update` with `high` reasoning, concise static Atom instructions, and only `load_atom_tools`, then waits up to ten seconds for `session.updated`.
4. Main recursively compares every sent session leaf with the returned session, emits the sent/returned/default tables to the trusted console, and terminates the socket on any mismatch or timeout.
5. A new user prompt uses the compact session surface. `load_atom_tools` must be the sole call and selects one to eight exact names.
6. Renderer validates the loader call. The next `response.create` overrides tools for that response with the loader plus only the selected concrete schemas; text and voice use the same definition factory.
7. Main returns one `AgentTurnResult`: opaque conversation ID, fixed transport observation, assistant text, function calls, response usage, and the latest server rate limits.
8. Renderer rejects any application call absent from the exact selected set, then applies its concrete Zod schema and policy.
9. Calls execute sequentially through the application host; no tool owns raw IPC or serial.
10. Results return as Realtime `function_call_output` conversation items. Screenshots become explicitly untrusted Realtime image input. The selected tool override remains only for the active operation.
11. Loop ends on assistant response, explicit denial/failure, or eight bounded tool rounds.

The gateway remembers at most four Realtime text conversations and expires idle conversations after five minutes. Renderer conversation IDs are opaque; API-specific objects, sockets and credentials stay in main. Text turns keep conversational continuity while Atom is open. A missing/expired conversation or any API failure stops with an explicit error; the gateway never opens a substitute conversation or replays a completed instrument operation.

Malformed output, unknown tools, bad JSON and invalid ranges become explicit
failed tool results inside the active bounded turn. Conversation/session
protocol failure and loop overflow terminate the affected transport.

### 6.2 Pull-based context contract

No mutable application snapshot is injected by default. Atom loads only the narrowest read tool needed for the current claim or operation. Available typed projections include:

- Current workspace and acquisition state.
- Simulation flag and visible error.
- Device identity, firmware, capabilities, mode, RF output and verification.
- Analyzer/generator/detector configuration.
- Active measurement view; host trace bank; markers/readouts; marker-search criteria; amplitude display; waterfall/channel/STFT configurations and computed result/error.
- Versioned Atomizer/Firmware/SignalLab topology, active driver/source/qualification, transport, USB-verification state when applicable, active measurement edge, and reserved stimulus-edge status.
- Latest sweep summary: range, points, peak, noise floor, detection count and timestamp.

Raw sweep arrays, screenshots, prior sessions, file contents, diagnostic logs and device serial numbers are excluded unless a declared tool explicitly requests them and the user's task requires them. Tool results are untrusted conversation data and cannot alter instructions, policy, model, or the response-scoped tool set.

## 7. Tool contract

### 7.1 Current tool catalog

| Tool | Risk | Approval | Effect |
|---|---|---|---|
| `load_atom_tools` | Routing only | Never | Selects one to eight exact registered names and installs their concrete schemas for the following response only; it cannot execute application behavior |
| `get_application_state` | Observe | Never | Reads route/acquisition/environment plus complete staged analyzer/generator/detection/measurement configuration |
| `get_system_topology` | Observe | Never | Reads the versioned trio, active driver/source/transport, active SignalLab measurement edge, and reserved SignalLab stimulus edge |
| `get_agent_surface` | Observe | Never | Reads compact tool/policy inventory, response-scoped loading contract, and UI-control bindings with projection and guarantee |
| `get_instrument_state` | Observe | Never | Reads driver/source identity, qualification, capabilities, and only source-applicable mode/RF state |
| `get_latest_sweep_summary` | Observe | Never | Reads minimized trace summary |
| `get_measurement_state` | Observe | Never | Reads four host trace modes, D1–D4 overlay visibility, eight markers/readouts, searches, and host display scale |
| `set_measurement_view` | Operate | Never | Selects Spectrum, Waterfall, Channel, or detected-envelope STFT |
| `configure_waterfall` | Operate | Never | Sets bounded coherent history depth and explicit dBm color scale |
| `configure_channel_measurement` | Operate | Never | Sets main/adjacent bandwidths, spacing, offset pairs, and OBW behavior |
| `get_channel_measurement_results` | Observe | Never | Calculates CHP/PSD/ACP/ACLR/OBW or returns the exact evidence failure |
| `configure_envelope_stft` | Operate | Never | Sets Hann window, hop, DC removal, and display range for detected power |
| `get_envelope_stft_results` | Observe | Never | Reads the latest detected-envelope STFT or exact failure |
| `acquire_envelope_stft` | Operate | Never | Acquires staged zero-span evidence and returns its Not-I/Q STFT |
| `get_detection_results` | Observe | Never | Reads tracked candidates, thresholds, persistence and release state |
| `get_classification_results` | Observe | Never | Reads spectral morphology and zero-span envelope evidence |
| `read_device_diagnostics` | Observe | Never | Refreshes identity, command catalog, readback and telemetry |
| `list_connection_candidates` | Observe | Never | Lists opaque candidate IDs and safe labels; excludes paths/serials |
| `connect_device` | Operate | Never | Connects exactly one previously listed instrument candidate; no default substitution |
| `disconnect_device` | Operate | Never | Disconnects the active instrument and preserves unknown-RF semantics where applicable |
| `inspect_interface` | Observe | Never | Derives rendered controls, availability, risk, preferred tool, projection, and guarantee from the live DOM |
| `computer_action` | Operate | Never* | Activates only synchronous UI-only controls; domain operations are excluded |
| `computer_screenshot` | Observe | Never | Captures only Atomizer and issues a short-lived one-use screenshot ID plus focused-target identity |
| `computer_click` | Operate | Never* | Consumes the latest screenshot ID for one hit-tested coordinate click |
| `computer_type` | Operate | Never | Inserts bounded text only when current focus equals `expectedTarget` |
| `computer_key` | Operate | Never | Sends one allow-listed key only when current focus equals `expectedTarget` |
| `computer_scroll` | Operate | Never | Consumes the latest screenshot ID for one bounded scroll |
| `navigate_workspace` | Operate | Never | Uses the same guarded route transition as UI |
| `configure_analyzer` | Operate | Never | Applies a non-empty partial patch to staged analyzer settings; omitted fields are preserved and the merged full config is validated |
| `select_marker` | Operate | Never | Selects one marker for editing without changing its configuration |
| `configure_marker` | Operate | Never | Configures one of eight host-derived markers through the measurement reducer |
| `configure_marker_search` | Operate | Never | Configures minimum level and local-peak excursion criteria |
| `search_marker` | Operate | Never | Places the active marker using peak/min/next search and explicit thresholds |
| `select_trace` | Operate | Never | Selects one trace for editing without changing its mode or accumulator |
| `configure_trace` | Operate | Never | Configures one of four host-derived trace accumulators |
| `configure_firmware_trace_visibility` | Operate | Never | Shows or hides one separately labeled firmware-readback overlay without changing the device trace |
| `reset_trace` | Operate | Never | Clears exactly one host trace accumulator |
| `configure_spectrum_display` | Operate | Never | Changes the host reference level and dB/div projection |
| `auto_scale_spectrum_display` | Operate | Never | Derives the display scale from the latest complete sweep or fails |
| `acquire_sweep` | Operate | Never | Runs one analyzer acquisition |
| `start_continuous_sweeps` | Operate | Never | Starts serialized service-owned acquisition |
| `stop_continuous_sweeps` | Operate | Never | Stops after the in-flight firmware operation |
| `configure_signal_detector` | Operate | Never | Changes detector and opens Detection |
| `select_classification_candidate` | Operate | Never | Selects one current detected-signal result for visual inspection |
| `configure_zero_span` | Operate | Never | Stages detected-power-versus-time capture settings |
| `acquire_zero_span` | Operate | Never | Captures and characterizes one envelope |
| `configure_generator` | Operate | Never | Commands output off and stages generator |
| `set_rf_output` | High impact | At action for enable | Enables/disables output on the connected execution backend and returns execution evidence |
| `capture_device_screen` | Observe | Never | Reads and displays one exact RGB565 frame |
| `remote_device_touch` | High impact | At action | Operates the general firmware UI, which may expose RF controls |
| `export_latest_sweep` | Operate | Never | Opens a native save dialog for provenance-preserving CSV/JSON |

Computer tools cannot access other windows, open external URLs, or bypass tool policies. Each click/scroll consumes the newest screenshot ID within 15 seconds and rejects changed window geometry; another coordinate action requires another screenshot. Type/key actions compare current focus with the exact expected target returned by a screenshot or preceding action. Elements marked high-impact or `data-agent-exclusion` are refused. RF output and remote touch route to typed action-time approval.

All 50 registered parameter schemas are generated from the same Zod objects used to accept execution. The persistent Realtime session never carries that entire registry: its one loader schema contains only the closed name enum, and `response.create` installs the selected concrete definitions for one response. Realtime requires a closed top-level `type: object` and rejects top-level `oneOf`, `anyOf`, `allOf`, `enum`, `const`, and `not`; catalog tests enforce that admission rule for every application tool. Cross-field constraints—trigger mode/level, marker delta reference, channel overlap, waterfall floor/ceiling, STFT hop/window, generator path/modulation, and merged analyzer span—remain fail-closed runtime refinements and are repeated in tool/property descriptions.

Transient numeric-entry panels are body-level portals carrying the originating row identity in `data-parameter-editor`. While open, the one stable `data-agent-control` moves from the occluded source row to the portal and the source becomes an explicit exclusion, so duplicate hooks cannot appear. Their field, keypad, unit terminators, and close/apply controls cannot create a second configuration path. When an exact domain tool exists—such as `configure_analyzer` or `configure_marker`—Atom uses it instead of reproducing keypad clicks; computer operation remains an app-scoped semantic/visual path, not a second validation path.

### 7.2 Every-feature hook rule

Every new application capability must include, in the same work package:

1. Domain request/result types.
2. Agent tool or explicit reason it is not agent-accessible.
3. Closed JSON schema and runtime validator.
4. Risk classification and approval timing.
5. Application-host executor using the same domain API as UI.
6. Human-readable tool activity copy.
7. State/context projection with data minimization.
8. Unit, denial, malformed-output and disconnect tests.
9. Voice phrasing/eval cases when useful by speech.
10. Documentation and traceability ID.

A feature is not complete when only its visual control exists.

## 8. App-scoped computer use

Atom’s computer use is confined to TinySA Atomizer. It combines a semantic interface map with a screenshot-first visual loop:

1. Electron captures only its own `BrowserWindow` content—never the desktop.
2. The screenshot is normalized to application CSS coordinates, assigned a 15-second one-use ID, and sent as explicitly untrusted image input with its focused-target identity on the active trusted Realtime transport.
3. Atom returns bounded click/scroll calls containing that exact ID, or type/key calls containing the exact expected focus target.
4. Main consumes the coordinate token, verifies unchanged window dimensions or exact focus, validates input, and hit-tests the current app DOM.
5. A high-impact target is blocked before activation and redirected to its typed approval tool.
6. Atom captures again to verify the result.

The harness has no OS-wide input injection, other processes, arbitrary URLs or files. Native domain tools remain preferred because they preserve exact units and provenance. Screenshot payloads are turn-scoped and excluded from logs/session persistence.

## 9. Approval and safety contract

### 9.1 Point-of-risk approval

Atom may complete safe preparatory work before asking. It requests approval immediately before the high-impact call and explains:

- Exact action.
- Physical or data risk.
- Relevant frequency/level/load state.
- What will change.

RF output enable always requires approval even if the original prompt requested it. Agent-driven connected-screen touch also requires approval because executable firmware UI can reach generator controls. The approval card states whether the target is physical hardware or the executable twin and never implies that the Renode bridge can radiate. Disabling typed RF output never waits for approval. Denial is returned to the model as a denial, not a tool failure to retry around.

Firmware installation is not an Atomizer approval path. Application contract 6
contains no updater UI, preload method, main-process IPC handler, or Atom tool.
Download, physical preflight, DFU, flashing, journaling, and recovery are owned
exclusively by standalone sibling `../TinySA_Flasher`. Its active interface
catalog v3 retains active application contract v2 (`deviceContractVersion: 2`);
interface catalog v2 and legacy application contract v1 are frozen.
This includes native-picker admission of manifested custom firmware. Atomizer's
warning-admitted `custom-unqualified` device identity is observation only and
cannot prove artifact bytes, qualification, or update success.

### 9.2 Non-bypass guarantees

- Model output cannot change policy.
- Rephrasing, voice, either text transport, computer action and future automation all use the same policy table.
- Raw serial, calibration, reset, SD deletion, firmware installation, and unrestricted filesystem/network tools are absent.
- Firmware identity remains observable device evidence but cannot create an Atomizer installation capability; users must use the standalone `TinySA_Flasher`.
- Tool descriptions are guidance; host validation and policy are authority.
- Disconnect while RF output may be on results in `unknown`; Atom must say it may still be emitting.
- Physical RF state is command-acknowledged rather than measured; executable-twin state is firmware-executed state and never evidence of physical emission. Atom must preserve the visible qualifier.
- Configuration, acquisition, and shutdown establish output off for RF-capable sessions. Touch invalidates RF/configuration state, and Atom cannot acquire or invoke unsafe features until explicit output-off recovery succeeds.

## 10. Prompt-injection and untrusted-data contract

Device strings, filenames, session annotations, imported data, classification labels, web/page content and future MCP results are untrusted data. They are delimited as data, never concatenated into system instructions. Tool outputs cannot add tools, relax approval or change model identity. The agent cannot execute instructions embedded in trace/session content.

Computer use is application-scoped specifically to prevent external pages from becoming an instruction source. Any future web research tool must isolate retrieved content, preserve citations and remain unable to control RF output.

## 11. AI-native UI contract

Atom has a dedicated spatial rail, not a modal chatbot:

- Exact model identity is visible.
- Realtime voice connects once at startup when configured, with the microphone muted by default and no automatic retry.
- Microphone and speaker controls are the connection/status indicators: disconnected, connected-muted, connected-live, speaking, and error use distinct colors; no microphone-shaped connection button remains.
- Current instrument context and connectivity are visible.
- Text, voice transcript, tool activity, failures and approvals share one chronological surface.
- Suggested workflows teach capabilities instead of generic conversation starters.
- Closing Atom preserves instrument work; opening it reflows rather than obscures the measurement plot at supported sizes.
- Violet/cyan indicates intelligence and voice; mint remains measurement truth; amber remains evidence/caution; red remains physical risk/fault.

## 12. Privacy, cost, and retention

- A configured app may establish one idle Realtime voice session automatically; it sends no microphone audio until the local human unmutes the disabled track.
- No background turns, hidden telemetry, automatic reconnect loop or always-on microphone.
- Status UI clearly distinguishes API configured, active voice and active tool execution.
- Session transcript retention is memory-only in the current slice; persistence requires an explicit setting and schema.
- The rail and console report exact `response.done.usage` and `rate_limits.updated` values without converting them into estimated billing claims.
- Atomizer does not configure `max_output_tokens`, a reduced context window, or truncation. It preserves the exact model's native output/context behavior; throughput is controlled by compact static instructions, one startup loader, pull-based state, and response-scoped concrete schemas.
- The rail exposes the configured reasoning effort; `high` may increase latency and token usage and is never silently reduced.
- Diagnostic bundles exclude prompts, transcripts and model payloads by default.

## 13. Error and recovery contract

Distinct user-facing errors exist for missing key, invalid key/auth, unavailable model, permission denied, microphone unavailable, network loss, rate limit, malformed model call, invalid tool arguments, denied approval, device disconnect, tool timeout and API server error. Secrets and raw response bodies never appear in errors.

Realtime voice failure closes all media resources. Text-transport failure preserves transcript, closes affected server sockets and never repeats a completed device operation automatically. Tool results carry idempotency/operation IDs when the device API gains them.

## 14. Evaluation contract

### 14.1 Tool correctness

- Tool-selection accuracy by RF task.
- Argument validity and unit accuracy.
- Multi-tool sequence correctness.
- No raw/unknown tool acceptance.
- No RF enable without approval.
- No policy bypass across text, voice or computer paths.
- Honest behavior for disconnected, stale, simulated and unknown states.

### 14.2 RF answer quality

Curated evals cover frequency/span conversion, dB versus dBm, RBW tradeoffs, attenuation/LNA, overload, spurs/harmonics, noise floor, marker interpretation, detector limits, classification uncertainty, signal-generator safety and repeatable experiment design. RF expert review is required for high-stakes claims.

### 14.3 Voice quality

- Task completion under hobbyist and engineer phrasing.
- Interruptibility and recovery.
- Correct alphanumeric/frequency recognition.
- Concise initial answer and optional depth.
- Tool progress understandable without watching the screen.
- No duplicate execution caused by partial transcripts or barge-in.

### 14.4 Computer-use quality

- Inspect before uncertain action.
- Select only allow-listed controls.
- Obey current enabled/disabled state.
- Preserve generator navigation guard.
- Prefer domain tools when exact settings are available.

## 15. Acceptance inventory

- **AI-01:** Every AI transport sends exactly `gpt-realtime-2.1`.
- **AI-02:** Standard key is absent from renderer/preload/build artifacts/logs.
- **AI-03:** Missing key produces unconfigured state and no network call.
- **AI-04:** Realtime call uses trusted unified SDP flow.
- **AI-05:** Voice stop closes tracks, channel and peer connection.
- **AI-06:** Text and voice share tool validation/policy.
- **AI-07:** Unknown tool and invalid args fail closed.
- **AI-08:** The Realtime text tool loop is bounded.
- **AI-09:** Context excludes raw sweep data by default.
- **AI-10:** RF enable always requests action-time approval.
- **AI-11:** RF disable never waits for approval.
- **AI-12:** Denial cannot be retried around automatically.
- **AI-13:** Computer action cannot escape TinySA Atomizer.
- **AI-14:** Computer action cannot enable RF output.
- **AI-15:** Device disconnect interrupts affected tools coherently.
- **AI-16:** Simulated/unknown/stale state is disclosed in answers.
- **AI-17:** Voice function output continues the same Realtime conversation.
- **AI-18:** No raw microphone recording or hidden background session.
- **AI-19:** Every product capability has an agent-hook disposition.
- **AI-20:** RF expert eval and red-team suite pass release thresholds.
- **AI-21:** Model/API/transport/conversation failure stops loudly with no retry, reroute, alias or substitute.
- **AI-22:** Text sockets are trusted-main-only, capacity bounded, idle-expiring and closed on app quit.
- **AI-23:** Acquisition cannot proceed from a dialog-open state; Atom lists, connects, and verifies `ready` first.
- **AI-24:** Voice and text sessions both send and retain `reasoning.effort = high`.
- **AI-25:** Voice sessions send and retain `voice = ballad` and `server_vad.threshold = 0.97`.
- **AI-26:** Voice and text operation remains gated until every sent session setting has an exact `session.updated` acknowledgement; mismatch/timeout fails visibly and server-only defaults remain inspectable.
- **AI-27:** Every implemented `AtomizerInstrumentApiV1` capability has a closed Atom tool, an explicitly capability-gated UI-only disposition, or a documented high-impact exclusion.
- **AI-28:** Remote connected-screen touch cannot execute through coordinate computer use and always reaches action-time approval through its typed tool.
- **AI-29:** Every declared Atomizer UI hook resolves to exactly one typed tool contract, risk class, projection, executor, and guarantee; marker-search criteria and auto-scale have first-class tools.
- **AI-30:** Text and voice share the identical compact loader and concrete-definition factory; the same selected names yield byte-equivalent response-scoped schemas, including app-scoped screenshot and computer tools.
- **AI-31:** Atom reports active SignalLab simulation, physical USB, executable-twin, protocol-test-double, and reserved SignalLab stimulus topology without conflation.
- **AI-32:** Voice function chains are bounded to eight application calls after one non-executing loader call, and duplicate call IDs terminate the session.
- **AI-33:** Every runtime method in `AtomizerInstrumentApiV1` has a machine-checked Atom tool or explicit agent exclusion, evidence projection, guarantee, and failure disposition; TinySA protocol-v3 details remain below its driver.
- **AI-34:** Every rendered button/input/select/textarea/disclosure has either one agent-control contract or an explicit human-agent/approval exclusion; no interactive affordance is orphaned.
- **AI-35:** Atomizer exposes no firmware-installation UI, IPC method, or Atom tool; standalone `TinySA_Flasher` is the exclusive owner. Its active interface catalog v3 retains active application contract v2 (`deviceContractVersion: 2`); interface catalog v2 and legacy application contract v1 are frozen.
- **AI-36:** Generic app-computer actions continue to fail closed on every local human-only or high-impact control.
- **AI-37:** The `AtomizerInstrumentApiV1` runtime catalog and preload contain no legacy updater method.
- **AI-38:** Firmware identity and custom-unqualified provenance never imply installation authority or a successful update.
- **AI-39:** Voice config includes and exactly verifies `audio.input.transcription.model = gpt-realtime-whisper`; user and assistant deltas stream into one message per turn.
- **AI-40:** Atom makes one startup voice connection attempt with microphone muted; mic/speaker state remains independently human-controlled and visually encoded.
- **AI-41:** Realtime calls are harvested only at `response.done`; all outputs precede exactly one continuation response.
- **AI-42:** Every one of the 50 tool definitions has a concrete JSON schema, matching runtime validator and policy; `configure_analyzer` is a non-empty patch merged into a full device config.
- **AI-43:** Invalid model tool arguments are returned as failed tool evidence for bounded correction and never terminate voice merely because a Zod parse failed.
- **AI-44:** Auto/manual/teardown voice races cannot create overlapping peers, tracks, or playback streams; applied echo cancellation, noise suppression, and AGC must all report true.
- **AI-45:** WebRTC call creation carries only the immutable exact-model bootstrap; the compact shared loader session is sent and exactly acknowledged before the muted microphone can be enabled.
- **AI-46:** Every coordinate action consumes one current screenshot ID; focus-sensitive input fails when `expectedTarget` no longer matches.
- **AI-47:** Every function schema is a closed top-level object with no Realtime-forbidden top-level combinator; runtime relational constraints remain authoritative.
- **AI-48:** Host trace Off and D1–D4 overlay visibility are separate typed operations; firmware-readback visibility never mutates device trace state.
- **AI-49:** The persistent text and voice session exposes only `load_atom_tools`; a loader response selects one to eight unique registered names and cannot mix loader and application calls.
- **AI-50:** Every application call is rejected unless present in the exact selected response-scoped set, then passes the same concrete Zod validator and policy used by the UI host.
- **AI-51:** Text sends its static `session.update` exactly once per socket and never rewrites instructions with mutable application context; current state is obtained through typed read tools.
- **AI-52:** Atomizer parses and exposes API-supplied response usage and rate-limit telemetry while configuring no `max_output_tokens`, reduced context window, or truncation policy.

## 16. Source traceability

| Contract | Source |
|---|---|
| Model, tools and policies | `packages/agent/src/index.ts` |
| Trusted API calls and routing | `apps/desktop/src/main/ai-gateway.ts` |
| Text-only Realtime session | `apps/desktop/src/main/realtime-text.ts` |
| Secret and IPC boundary | `apps/desktop/src/main/main.ts`, `preload.ts` |
| WebRTC and Realtime text loops | `apps/desktop/src/renderer/useAtomAgent.ts` |
| Tool execution | `apps/desktop/src/renderer/App.tsx` |
| Native visual rail | `components/AtomAgentPanel.tsx`, `styles.css` |

## 17. Official OpenAI references

- Model: https://developers.openai.com/api/docs/models/gpt-realtime-2.1
- Per-response Realtime tool overrides: https://developers.openai.com/api/reference/resources/realtime/client-events#response.create
- Realtime usage and context accounting: https://developers.openai.com/api/docs/guides/realtime-costs
- Realtime rate-limit telemetry: https://developers.openai.com/api/reference/resources/realtime/server-events#rate_limits.updated
- Realtime WebRTC: https://developers.openai.com/api/docs/guides/realtime-webrtc
- Realtime WebSocket: https://developers.openai.com/api/docs/guides/realtime-websocket
- Realtime conversations and function calls: https://developers.openai.com/api/docs/guides/realtime-conversations
- Realtime voice activity detection: https://developers.openai.com/api/docs/guides/realtime-vad
- Realtime input transcription: https://developers.openai.com/api/docs/guides/realtime-transcription
- Realtime reasoning and prompting: https://developers.openai.com/api/docs/guides/realtime-models-prompting
- Function calling: https://developers.openai.com/api/docs/guides/function-calling
- Computer use and confirmation guidance: https://developers.openai.com/api/docs/guides/tools-computer-use
