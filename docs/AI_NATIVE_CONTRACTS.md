# Atom AI — Native Agent, Voice, Tool, and Computer-Use Contract

Status: execution baseline  
Version: 2.0.0
Model lock: `gpt-realtime-2.1-mini`  
Reasoning lock: `high`  
Voice lock: `ballad`  
VAD lock: `server_vad`, threshold `0.95`  
Updated: 2026-07-10

This document is normative. “Atom” is the application-layer AI inside TinySA Atomizer. It is not a general desktop agent and not a chat feature layered over the UI. It is an alternate, fully governed control surface for the same typed instrument capabilities used by the visual application.

## 1. Exact model contract

Every AI path uses exactly `gpt-realtime-2.1-mini`:

| Path | API | Purpose |
|---|---|---|
| Voice | Realtime API over WebRTC | Native speech-to-speech, interruption, conversation, function calls |
| Text agent | Realtime API over trusted WebSocket | Text reasoning, multi-step application tools, screenshot input, app-scoped computer control |

No fallback model, API, endpoint, transport, alias substitution, silent upgrade, retry route, or second reasoning model is permitted. Voice uses Realtime WebRTC; text/tools/computer use Realtime WebSocket. Any authentication, authorization, model, rate-limit, network, protocol or server failure is surfaced and execution stops. Model or transport changes require a contract change, prompt/tool regression evaluation, and explicit owner approval.

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
                              tinySA USB CDC
```

### 2.1 Credential boundary

- `OPENAI_KEY` is the sole credential name and is accepted only in the trusted Electron main process.
- `.env` is loaded only by main and is git-ignored.
- The credential is never placed in Vite variables, preload, renderer state, WebRTC events, logs, diagnostics, session files or exports.
- Renderer IPC can ask whether AI is configured; it cannot read, set, validate or export the key.
- Realtime uses the unified WebRTC interface: main posts SDP plus session configuration to `/v1/realtime/calls` with the standard key and returns only the SDP answer.
- Text uses a server-side Realtime WebSocket with an authorization header. The socket and key never cross preload.
- Production credential storage must migrate from plaintext `.env` to OS keychain or an owner-approved local broker before public distribution.

### 2.2 Network boundary

Only trusted main may call OpenAI REST endpoints or open the text-agent WebSocket. Realtime voice media is carried by the renderer’s WebRTC peer after trusted session creation. No measurement data is transmitted merely because AI is configured; data is included only in an active user-initiated Atom turn/session and is minimized to the context necessary for the request.

## 3. Atom identity and behavior

Atom serves two audiences without pretending they have the same needs:

- **RF hobbyist:** explains concepts, suggests safe starting settings, narrates what the trace may indicate, distinguishes instrument artifacts from evidence, teaches next experiments.
- **RF engineer:** moves quickly through precise ranges/settings, summarizes measurements, manages repeatable workflows, surfaces provenance/limitations, and avoids elementary prose unless asked.

Atom must:

- Read current state before making state-dependent claims.
- Prefer native typed tools over describing clicks or using computer control.
- Use integer Hz and explicit dB/dBm units in tool calls.
- Distinguish requested, commanded, verified, stale, simulated and unknown values.
- Never invent a waveform classification or imply regulatory-grade accuracy.
- Never describe software as an RF interlock.
- Keep initial spoken responses concise and offer deeper analysis.
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

1. User explicitly activates the microphone.
2. Renderer requests microphone permission and creates one `RTCPeerConnection`.
3. Renderer adds one microphone track and one `oai-events` data channel.
4. Renderer sends SDP through allow-listed IPC.
5. Main validates size/shape and calls `/v1/realtime/calls` with the exact model, `high` reasoning, `ballad` voice, `server_vad` threshold `0.95`, Atom instructions and the governed voice-safe tool subset.
6. Main returns SDP only; renderer sets the remote answer.
7. The microphone track remains muted while the first `session.created` event is recursively compared with every setting in the exact object sent by main. API-supplied defaults and initial differences are logged separately.
8. Renderer sends the identical shared configuration through `session.update` and starts a bounded ten-second acknowledgement timer.
9. Every `session.updated` echo is recursively compared. At least one exact acknowledgement must arrive before the timer expires; any final mismatch or timeout is emitted to the console, shown in Atom, and terminates the voice session.
10. Only after an exact acknowledgement does the renderer unmute the microphone and enter Listening. Remote audio auto-plays only for this user-initiated session.

### 5.2 Voice behavior

- Server voice-activity detection uses activation threshold `0.95`, creates responses, and allows interruption.
- Chromium is asked for echo cancellation, noise suppression and automatic gain control. Requested and applied `MediaStreamTrack` settings are emitted together in the console.
- `session.created` and every `session.updated` check emit every sent leaf, the full returned session, and every server-only/default setting in a collapsed console group.
- Mic, peer connection, data channel and media tracks close on user stop, window close, session failure or component teardown.
- User and assistant transcripts appear in the same Atom history used by text.
- Partial assistant transcripts are not persisted as complete messages.
- Function calls arriving on the data channel go through the identical validator, policy and approval path as text-agent calls.
- Tool output is returned as `function_call_output`; Atom is then asked to continue.
- The app never records raw microphone audio locally in v1.

## 6. Text agent transport contract

### 6.1 Turn protocol

1. Renderer creates a minimized application context snapshot and submits one typed `AgentTurnRequest` over named IPC.
2. Main opens or continues the sole trusted text-only Realtime WebSocket using the exact model.
3. Main sends `session.update` with `high` reasoning, then `conversation.item.create` and `response.create` with text output, Atom instructions, delimited application context and tool schemas.
4. Main returns one `AgentTurnResult`: opaque conversation ID, fixed transport observation, assistant text and function-call name/arguments/call ID.
5. Renderer validates each call against the local Zod schema and policy.
6. Calls execute sequentially through the application host; no tool owns raw IPC or serial.
7. Results return as Realtime `function_call_output` conversation items. Screenshots become Realtime image input.
8. Loop ends on assistant response, explicit denial/failure, or eight bounded tool rounds.

The gateway remembers at most four Realtime text conversations and expires idle conversations after five minutes. Renderer conversation IDs are opaque; API-specific objects, sockets and credentials stay in main. Text turns keep conversational continuity while Atom is open. A missing/expired conversation or any API failure stops with an explicit error; the gateway never opens a substitute conversation or replays a completed instrument operation.

Malformed output, unknown tools, bad JSON, invalid ranges and loop overflow fail closed.

### 6.2 Context contract

Default context may include:

- Current workspace and acquisition state.
- Simulation flag and visible error.
- Device identity, firmware, capabilities, mode, RF output and verification.
- Analyzer/generator/detector configuration.
- Host trace bank, active markers/readouts, amplitude display, selected demo waveform qualification, and replay-channel state.
- Latest sweep summary: range, points, peak, noise floor, detection count and timestamp.

Raw sweep arrays, screenshots, prior sessions, file contents, diagnostic logs and device serial numbers are excluded unless a future tool explicitly requests them and the user’s task requires them. Context is bounded to 80,000 characters at the trusted boundary.

## 7. Tool contract

### 7.1 Current tool catalog

| Tool | Risk | Approval | Effect |
|---|---|---|---|
| `get_application_state` | Observe | Never | Reads route/acquisition/environment |
| `get_instrument_state` | Observe | Never | Reads identity/mode/capabilities/RF state |
| `get_latest_sweep_summary` | Observe | Never | Reads minimized trace summary |
| `get_measurement_state` | Observe | Never | Reads the four trace modes, eight markers/readouts, searches, and host display scale |
| `get_detection_results` | Observe | Never | Reads tracked candidates, thresholds, persistence and release state |
| `get_classification_results` | Observe | Never | Reads spectral morphology and zero-span envelope evidence |
| `read_device_diagnostics` | Observe | Never | Refreshes identity, command catalog, readback and telemetry |
| `list_connection_candidates` | Observe | Never | Lists opaque candidate IDs and safe labels; excludes paths/serials |
| `connect_device` | Operate | Never | Connects exactly one previously listed candidate; no default substitution |
| `disconnect_device` | Operate | Never | Disconnects the active device and preserves unknown-RF semantics |
| `inspect_interface` | Observe | Never | Reads semantic controls and availability |
| `computer_action` | Operate | Never* | Activates an allow-listed TinySA Atomizer control |
| `computer_screenshot` | Observe | Never | Captures only the TinySA Atomizer content area |
| `computer_click` | Operate | Never* | Hit-tested screenshot-coordinate click inside the app |
| `computer_type` | Operate | Never | Bounded text into the focused app control |
| `computer_key` | Operate | Never | One allow-listed key/shortcut inside the app |
| `computer_scroll` | Operate | Never | Bounded scroll inside the app |
| `navigate_workspace` | Operate | Never | Uses the same guarded route transition as UI |
| `configure_analyzer` | Operate | Never | Changes staged analyzer settings only |
| `configure_marker` | Operate | Never | Configures one of eight host-derived markers through the measurement reducer |
| `search_marker` | Operate | Never | Places the active marker using peak/min/next search and explicit thresholds |
| `configure_trace` | Operate | Never | Configures one of four host-derived trace accumulators |
| `reset_trace` | Operate | Never | Clears exactly one host trace accumulator |
| `configure_spectrum_display` | Operate | Never | Changes the host reference level and dB/div projection |
| `acquire_sweep` | Operate | Never | Runs one analyzer acquisition |
| `start_continuous_sweeps` | Operate | Never | Starts serialized service-owned acquisition |
| `stop_continuous_sweeps` | Operate | Never | Stops after the in-flight firmware operation |
| `configure_signal_detector` | Operate | Never | Changes detector and opens Detection |
| `configure_zero_span` | Operate | Never | Stages detected-power-versus-time capture settings |
| `acquire_zero_span` | Operate | Never | Captures and characterizes one envelope |
| `configure_generator` | Operate | Never | Commands output off and stages generator |
| `set_rf_output` | High impact | At action | Enables/disables physical output |
| `capture_device_screen` | Observe | Never | Reads and displays one exact RGB565 frame |
| `remote_device_touch` | High impact | At action | Operates the general firmware UI, which may expose RF controls |
| `export_latest_sweep` | Operate | Never | Opens a native save dialog for provenance-preserving CSV/JSON |
| `select_demo_signal` | Operate | Never | Selects one closed visual/standards-derived Signal Lab waveform and its recommended range |
| `configure_demo_channel` | Operate | Never | Changes the explicit AWGN/Rayleigh replay-channel schema |

Computer tools cannot access other windows, open external URLs, or bypass tool policies. Screenshot-relative clicks are hit-tested against the live DOM immediately before activation. Elements marked high-impact are refused; the model must use the typed tool with action-time approval. Text, key and scroll inputs are bounded and remain targeted at TinySA Atomizer.

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
2. The screenshot is normalized to application CSS coordinates and sent as image input on the active trusted text transport.
3. Atom returns bounded click/type/key/scroll function calls.
4. Main validates coordinates/input and hit-tests the current app DOM.
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

RF output enable always requires approval even if the original prompt requested it. Agent-driven physical-screen touch also requires approval because the firmware UI can reach generator controls. Disabling typed RF output never waits for approval. Denial is returned to the model as a denial, not a tool failure to retry around.

### 9.2 Non-bypass guarantees

- Model output cannot change policy.
- Rephrasing, voice, either text transport, computer action and future automation all use the same policy table.
- Raw serial, calibration, reset, SD deletion, DFU and unrestricted filesystem/network tools are absent.
- Tool descriptions are guidance; host validation and policy are authority.
- Disconnect while RF output may be on results in `unknown`; Atom must say it may still be emitting.

## 10. Prompt-injection and untrusted-data contract

Device strings, filenames, session annotations, imported data, classification labels, web/page content and future MCP results are untrusted data. They are delimited as data, never concatenated into system instructions. Tool outputs cannot add tools, relax approval or change model identity. The agent cannot execute instructions embedded in trace/session content.

Computer use is application-scoped specifically to prevent external pages from becoming an instruction source. Any future web research tool must isolate retrieved content, preserve citations and remain unable to control RF output.

## 11. AI-native UI contract

Atom has a dedicated spatial rail, not a modal chatbot:

- Exact model identity is visible.
- Voice is the hero interaction with explicit listening/thinking/speaking states.
- Current instrument context and connectivity are visible.
- Text, voice transcript, tool activity, failures and approvals share one chronological surface.
- Suggested workflows teach capabilities instead of generic conversation starters.
- Closing Atom preserves instrument work; opening it reflows rather than obscures the measurement plot at supported sizes.
- Violet/cyan indicates intelligence and voice; mint remains measurement truth; amber remains evidence/caution; red remains physical risk/fault.

## 12. Privacy, cost, and retention

- AI is off unless configured and user-initiated.
- No background turns, hidden telemetry or always-on microphone.
- Status UI clearly distinguishes API configured, active voice and active tool execution.
- Session transcript retention is memory-only in the current slice; persistence requires an explicit setting and schema.
- A future usage view should report request/audio duration and token usage returned by APIs without estimating billing claims.
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

- **AI-01:** Every AI transport sends exactly `gpt-realtime-2.1-mini`.
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
- **AI-25:** Voice sessions send and retain `voice = ballad` and `server_vad.threshold = 0.95`.
- **AI-26:** The microphone remains muted until every sent voice-session setting has an exact `session.updated` acknowledgement; mismatch/timeout fails visibly and server-only defaults remain inspectable.
- **AI-27:** Every implemented API v2 capability has a closed Atom tool or a documented high-impact exclusion.
- **AI-28:** Remote physical-screen touch cannot execute through coordinate computer use and always reaches action-time approval through its typed tool.
- **AI-29:** Every marker, trace, display, waveform, and replay-channel operation has a closed typed tool and returns its evidence/qualification state.

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

- Model: https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini
- Realtime WebRTC: https://developers.openai.com/api/docs/guides/realtime-webrtc
- Realtime WebSocket: https://developers.openai.com/api/docs/guides/realtime-websocket
- Realtime conversations and function calls: https://developers.openai.com/api/docs/guides/realtime-conversations
- Realtime voice activity detection: https://developers.openai.com/api/docs/guides/realtime-vad
- Realtime reasoning and prompting: https://developers.openai.com/api/docs/guides/realtime-models-prompting
- Function calling: https://developers.openai.com/api/docs/guides/function-calling
- Computer use and confirmation guidance: https://developers.openai.com/api/docs/guides/tools-computer-use
