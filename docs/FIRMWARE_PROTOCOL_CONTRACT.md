# ZS407 host protocol contract

Status: implementation baseline

Version: 2.2.0

Host baseline source: `c97938697b6c7485e7cab50bca9af76996b7d671`
Observed shipped source: `c5dd31fd4679c15ba92ff46a6e258c1e3516ff0c`
Custom-probe reference source: `53850c4aa4f8947e4a7ab3ebef553dad1f8e770d`

Target: tinySA Ultra+ ZS407 (`hwid` 103)

This contract is derived from the pinned firmware source in the sibling
`Atom-Firmware` checkout. It replaces guessed serial behavior in the desktop
application. Firmware source is authoritative for framing and command behavior;
the physical unit remains authoritative for timing, calibration, RF accuracy and
the exact shipped version.

## Evidence boundary

The following are source facts:

- USB is CDC ACM, VID `0483`, PID `5740`, manufacturer `tinysa.org`, product
  `tinySA4`.
- Commands are printable ASCII, terminated by carriage return, and echoed by the
  firmware.
- Text responses end with the exact prompt `ch> `.
- The shell line buffer is 48 bytes, leaving 47 command characters before the
  terminator.
- State-changing commands are serialized into the sweep thread when marked
  `CMD_WAIT_MUTEX`.
- A queued sweep-thread command can emit `Command timeout` after four five-second
  wait periods.
- ZS407 identity is reported as hardware `V0.5.4`, `+ ZS407`, `hwid` 103 and the
  MAX2871 path in this source baseline.

The delivered unit has established:

- exact macOS CDC path, `0483:5740`, manufacturer `tinysa.org`, serial `400`;
- shipped `version`, `info`, 77-command `help`, battery and device-ID responses;
- ZS407 product evidence in `info` when the shipped hardware line omits the model;
- mutually consistent 101-point text and raw receive sweeps;
- configurable raw-sweep offset readback of 174 dB;
- exact 307,200-byte LCD capture.

The following still require physical qualification:

- sustainable command and sweep cadence;
- whether host serial stacks deliver the boot banner before the first command;
- command behavior during cable loss and long-running acquisition;
- calibrated usable range, level uncertainty and path transition artifacts;
- recovery after an interrupted generator command.

## Transport and correlation

```text
transport                 USB CDC ACM
vendor/product            0483:5740
command encoding          printable ASCII
command terminator        CR (0x0d)
command echo              required
text newline              CR LF
terminal prompt           "ch> "
maximum command text      47 characters
firmware shell banner     CR LF "tinySA Shell" CR LF "ch> "
```

The host correlates every response to the exact echoed command. A prompt observed
before that echo is startup/stale traffic and cannot complete a request. Commands
are strictly serialized. A timeout, malformed echo, invalid UTF-8, malformed
binary payload or unexpected disconnect faults the session; the host does not
continue on a potentially desynchronized stream.

## Required command surface

Atomizer requires only the receive-safe connection minimum after `help`
capability discovery:

| Domain | Commands |
| --- | --- |
| identity | `version`, `info`, `help` |
| RF safety and receive mode | `output`, `mode` |
| conservative readback | `sweep`, `zero`, `rbw`, `attenuate`, `status` |
| telemetry | `vbat`, `deviceid` |

An absent required command is an unsupported-firmware error, not a reason to try
an alternate spelling or older protocol. `scan`, `scanraw`, `trace`,
`sweeptime`, `calc`, `spur`, `avoid`, `lna`, and `trigger` are optional inputs to
the derived receiver capability. Advertising required `zero` command presence
does not itself authorize raw acquisition: the exact safe `zero ?` probe and
`scanraw` surface must still prove usable offset readback. Generator, screen,
remote-panel, firmware trace, and marker features are also optional.
The supported OEM/twin profiles receive only the optional features whose
commands are advertised. A reduced custom receiver receives only behavior
established by the exact safe probes below plus any narrowly registered source
proof; if the result cannot form a complete acquisition, the generic instrument
connection is rejected.

## Custom-firmware capability probes

An unknown but syntactically valid revision with exact physical USB and ZS407
identity remains `custom-unqualified`. Command names in `help` are not behavioral
proof, so Atomizer sends the following closed, read-only probe set and parses the
whole response. Extra, missing, duplicated, or prose-contaminated lines do not
partially match.

The exact `0483:5740` USB identity and strict ZS407 product identity admit a
host-bounded **receive-only** tuning envelope of 0–900 MHz: the normal ZS407
input path only. The connected startup span is state, not a capability limit.
Custom firmware receives no Ultra/harmonic range, generator range, screen,
touch, or marker capability from that hardware identity. Each requested tune
inside the envelope remains tentative until the adapter has sent acknowledged
`output off`, restored `mode input`, applied the complete analyzer transaction,
and reread the exact requested start, stop, and point count. A rejection,
different readback, or safety-command failure invalidates the configuration and
leaves no acquisition binding.

One exact custom receiver identity is separately registered:
`tinySA4_hw-v0.3-fft1024-g43eb0f1` maps to frozen source commit
`43eb0f193c8619cb7ca23726e3062973c65ae958`. Audited source proves
`set_sweep_points` clamps to 20–450, so the
`custom-source-qualified-receive-only` projection may request that full point
range even when cold readback is 101. The serial shell does not attest the
documented binary SHA-256
`6f284a24c4b4ab178da13af97e102e1a624618c9a67e8418b19bbc153e6f0174`;
the warning remains visible and this is not OEM, hardware/RF, or metrology
qualification. Generator, screen, touch, marker, firmware-trace-bank, and
Ultra/harmonic authority remain absent. A decorated, dirty, alternate, or
short-hash-only identity falls back to `custom-unqualified`.

The extension point for another frozen custom build is the closed receiver
source registry in `packages/contracts/src/firmware-provenance.ts`. A reviewed
entry must bind the exact clean embedded version, full immutable source commit,
documented artifact SHA-256, and narrowly audited capability projection.
Runtime code never inspects `../Atom-Firmware`, a branch, or dirty `HEAD` to
grant trust.

| Surface | Probe | Exact source shape used for admission |
| --- | --- | --- |
| sweep configuration | `sweep ?` | three lines: the start/stop/points form, sweep-mode form, and named-frequency form |
| text scan | `scan ? ? ? ? ?` | one `usage: scan ...` line |
| raw scan | `scanraw ?` | one `usage: scanraw ...` line |
| raw offset | `zero ?` | `usage: zero {level}` plus one bounded integer-dBm line |
| trace | `trace ?` | all four source lines, including unit, scale/reference, value readback, and copy/freeze/subtract/view/value forms |
| RBW | `rbw ?` | usage range plus the current Hz/kHz value |
| attenuation | `attenuate ?` | usage range plus the current numeric value |
| sweep time | `sweeptime ?` | usage range plus the current seconds/milliseconds value |
| detector | `calc ?` | usage options plus one exact current-mode token |
| enum controls | `spur ?`, `avoid ?`, `lna ?`, `trigger ?` | each command's exact source usage lines |

`scan ?` is deliberately forbidden as a probe. In firmware commit `53850c4`,
`cmd_scan` treats any single argument as a repeat count; `?` therefore reaches
the acquisition path and does not emit usage. Five arguments take the over-arity
usage branch before parsing, scanning, or geometry mutation. After every custom
probe sequence, Atomizer sends `output off`, restores `mode input`, rereads
`sweep`, and rejects any geometry change or failed restoration.

## Identity

`version` returns the firmware identifier on the first line and a hardware line.
The host baseline may return:

```text
HW Version:V0.5.4 + ZS407 max2871
```

The delivered `v1.4-217` unit instead returns:

```text
tinySA4_v1.4-217-gc5dd31f
HW Version:V0.5.4 max2871
```

and `info` begins with exact product evidence:

```text
tinySA ULTRA+ ZS407
```

Atomizer accepts a physical session only with exact `0483:5740` USB,
`tinySA4_` firmware, a hardware line, strict ZS407 evidence across `version` and
`info`, the receive-safe command minimum, and acknowledged output-off framing.
The closed shell-identity registry maps exactly
`tinySA4_v1.4-217-gc5dd31f` to the shipped full commit and exactly
`tinySA4_v1.4-224-gc979386` to the pinned OEM/host full commit; only those full
version/revision/commit tuples receive supported-OEM provenance and pinned
ZS407 capability defaults. The separate exact custom receiver record above
receives only its frozen-source 20–450 point proof and never inherits the OEM
profile. A decorated or alternate version carrying any
known Git suffix is not equivalent and is warning-admitted as
`custom-unqualified`, just like any other unknown syntactically valid revision,
only when its safe probes establish a usable receiver surface. It receives no source
commit, OEM metrology qualification, generator domain, or unprobed capability.
Malformed revisions and failed/ambiguous probes remain unsupported. The
test-only protocol double may return the same shell identity but must preserve
`execution=protocol-test-double`, `usbIdentityVerified=false`, and test-only
qualification. The executable Firmware twin preserves
`execution=firmware-digital-twin`, `transport=renode-monitor-bridge`, and
`usbTransactionsModeled=false`; it is never admitted through physical USB
identity. Other serial ports remain visible for selection but fail
identification loudly.

## Firmware-derived ZS407 limits

| Capability | Contract |
| --- | ---: |
| normal analyzer ceiling | 900 MHz |
| custom-unqualified physical receive-only envelope | 0–900 MHz; exact ZS407 USB/model only, exact per-retune readback required |
| exact `43eb0f1` custom receiver points | 20–450; frozen source proof only, serial binary unattested, exact per-retune readback required |
| Ultra transition (`6.3 GHz + 1.0701 GHz`) | 7.3701 GHz |
| default third-harmonic command ceiling | 17.9226 GHz |
| analyzer points | 20–450 (host-safe subset) |
| RBW command | 0.2–850 kHz or `auto` |
| attenuation command | 0–31 dB integer or `auto` |
| requested sweep time | 3 ms–60 s, or firmware minimum via zero |
| host display frame | 480×320 RGB565 little-endian |
| raw RSSI representation | signed 16-bit little-endian Q5 of `powerDbm + ext_zero_level` |

The harmonic ceiling is command-addressable firmware behavior, not an RF accuracy
claim. The UI marks all ranges above the normal/Ultra transitions as
firmware-derived and awaiting device qualification.

## Analyzer transaction

Configuration is deterministic because `mode input` resets input-mode state. The
host then sends, in order:

1. `output off` when leaving a generator session;
2. `mode input`;
3. `trace dBm`;
4. `sweep <startHz> <stopHz> <points>`;
5. `rbw <auto|kHz>`;
6. `attenuate <auto|dB>`;
7. `sweeptime <seconds>` when a non-auto duration is requested;
8. `calc <detector>`;
9. `spur <off|on|auto>`;
10. `avoid <off|on|auto>`;
11. `lna <off|on>`;
12. `trigger <auto|normal|single>` and an explicit level when required.

The host reads `sweep`, `rbw`, `attenuate` and `status` after configuration.
Start, stop and point count are `verified` only when the returned values match.
Actual RBW and attenuation are recorded because firmware auto-selection may differ
from the request.

## Firmware marker and trace surface

The pinned tinySA4 build defines eight markers (`MARKER_COUNT = 8`) and four
traces (`TRACES_MAX = 4`). These counts are published through the device
capability profile.

The `marker` command accepts marker selection/listing and firmware operations for
`on`, `off`, `peak`, `delta`, `noise`, `tracking`, trace assignment, trace
averaging, and fixed frequency/index placement. The `trace` command accepts
units (`dBm`, `dBmV`, `dBuV`, `RAW`, `V`, `Vpp`, `W`), scale/reference level,
trace value access, copy, freeze, subtract, and view operations across traces
1–4.

This is not a complete trace-configuration readback claim. The trace-list output
does not round-trip every property and the pinned formatting may omit the
frozen argument. Atomizer records that property as `unknown` unless it is
explicitly present.

The value surface is usable. After every complete sweep Atomizer queries
`trace`, validates each enabled Ultra trace ID in `1..4`, and reads every point
of enabled stored/raw traces with `trace <id> value`. Trace 1 is coherently
identified with the just-acquired measured sweep; Trace 2 and Trace 3 are stored
slots; Trace 4 is the raw/temp slot. Any malformed line, duplicate/missing
index, non-finite dBm value, or wrong point count rejects the acquisition. These
frames carry `evidence=firmware-readback` and are exposed as `D1..D4` device
traces. Plot visibility is a separate host display projection, defaults off,
and never changes the enabled/frozen state reported by firmware.

Separately, Atomizer derives four simultaneous Clear/Write, Max Hold, Min Hold,
Average, View/Freeze and Blank frames from the exact host sweep arrays. Its
eight marker readouts are derived from those host frames. These carry
`evidence=host-derived` and render as `H1..H4`. Device and host traces never
impersonate one another; exact mode semantics remain governed by
`MEASUREMENT_CONTROLS_CONTRACT.md`.

No failed host projection falls through to firmware marker manipulation or
remote screen touch. Firmware trace values are read-only evidence; Atomizer
does not infer missing device configuration from them.

## Sweep payloads

### Text sweep

Atomizer's canonical acquisition command is:

```text
scan <startHz> <stopHz> <points> 3
```

Outmask 3 emits one row per point:

```text
<frequencyHz> <actualTraceValue> <reservedFloat>
```

The host requires exactly the requested number of finite, monotonic rows. It
preserves elapsed host time, requested settings, read-back settings, identity,
source and completeness with every sweep.

### Raw sweep

`scanraw <startHz> <stopHz> <points> 0` emits:

```text
"{" ("x" int16_le_q5_offset_db){points} "}" "ch> "
```

The parser validates every marker and the exact point count. Binary payloads use
fixed length and cannot be delimited by searching for prompt bytes inside sample
data. The firmware adds configurable `config.ext_zero_level` before encoding;
the delivered ZS407 default is 174 dB. Atomizer queries `zero` immediately before
each raw sweep, parses its integer `dBm` readback, divides samples by 32,
subtracts the observed offset, and records `rawSweepOffsetDb` with the sweep. It
does not mutate the device offset. Raw frequency points follow firmware’s
`(stop-start)/points` step, so the last raw point is one step below requested
stop; the actual frequency grid is retained rather than relabeled.

### Zero span

Equal start/stop scan values produce repeated RSSI observations at one tuned
frequency. They are envelope/power samples, not I/Q. Atomizer labels the x-axis
as elapsed time and never represents zero span as instantaneous RF bandwidth.

## Generator transaction and safety

`mode output` resets generator mode with `setting.mute = true`; Atomizer also sends
`output off` before and after entering the mode. Configuration then sends output
path, frequency, level, modulation frequency/depth/deviation, and finally the
selected modulation (`off`, `am` or `fm`).

The stock shell provides no dependable readback for generator frequency, level,
modulation or mute. These values are therefore `commanded`, never `verified`.
Enabling output requires action-time human approval for Atom. Reconnect never
restores output. A disconnect leaves physical RF state `unknown` even if an off
command was attempted.

## Screen and remote touch

On the physical ZS407, `capture` emits exactly `480 × 320 × 2 = 307,200` RGB565
panel bytes before the prompt, with each canonical word's high byte first. The
device adapter swaps each physical pixel once into the RGB565 little-endian
`ScreenFrame` contract. The executable-twin bridge exports that normalized host
format directly. `touch x y` accepts bounded panel coordinates. `release`
optionally accepts the final coordinates. Remote touch is a general instrument
UI operation and can reach RF controls; agent-driven remote touch is therefore
Host continuous acquisition is stopped after its in-flight sweep before a press
is sent. Press and release execute through one serialized application queue.
Only after a successful release does Atomizer reapply/verify its staged analyzer
configuration and resume acquisition when it was previously running. A failed
gesture stays visible and is not raced by the sweep loop or automatically
retried.

## Readback matrix

| State | Readback | Verification |
| --- | --- | --- |
| firmware/hardware identity | `version`, `info` | observed |
| command support | `help` | observed |
| analyzer range/points | `sweep` | verified |
| actual RBW | `rbw` query output | observed |
| actual attenuation | `attenuate` query output | observed |
| raw sweep offset | `zero` query output immediately before transfer | observed and retained per raw sweep |
| marker/trace slot counts | pinned firmware constants and `help` support | capability-derived |
| enabled device trace values | `trace`, `trace <id> value` with exact point count | firmware-readback (`D1..D4`) |
| simultaneous desktop trace frames | complete acquired sweeps | host-derived (`H1..H4`) |
| desktop marker readouts/search | assigned host trace frames | host-derived |
| paused/resumed | `status` | observed |
| battery voltage | `vbat` | observed telemetry |
| device ID | `deviceid` | observed telemetry |
| generator configuration | none | commanded only |
| physical generator output | none | commanded/unknown |

## Acceptance tests

- `FW-PROTO-001`: startup prompts before the echoed command cannot resolve it.
- `FW-PROTO-002`: split prompts and echoes reassemble without loss.
- `FW-PROTO-003`: overlong commands fail before transport write.
- `FW-PROTO-004`: command timeout faults the session and cancels queued work.
- `FW-PROTO-005`: `scan` rejects missing, extra, non-finite or non-monotonic rows.
- `FW-PROTO-006`: `scanraw` validates braces, sample markers, Q5 decoding, the immediate `zero` offset readback, subtraction, and retained offset provenance.
- `FW-PROTO-007`: screen capture consumes exactly 307,200 bytes before prompt.
- `FW-PROTO-007A`: physical RGB565 panel-order bytes normalize exactly once to the RGB565LE host frame.
- `FW-PROTO-008`: physical identity without ZS407 fails connection.
- `FW-PROTO-009`: generator configuration begins and ends muted.
- `FW-PROTO-010`: disconnect while output may be active yields `unknown` RF state.
- `FW-PROTO-011`: capability discovery requires both `trace` and `marker` and reports four/eight slots.
- `FW-PROTO-012`: desktop trace/marker projections remain labeled host-derived and never impersonate firmware readback.
- `FW-PROTO-013`: the shipped hardware line plus strict `info` product line admits ZS407; either response without sufficient model evidence rejects.
- `FW-PROTO-014`: an unknown syntactically valid source revision is admitted only as `custom-unqualified` after exact ZS407 identity, required command/framing and output-off checks; its warning and unresolved source provenance remain visible.
- `FW-PROTO-015`: every enabled Ultra firmware trace has one unique ID in `1..4`, exact contiguous indices and the acquired point count; malformed device trace readback rejects.
- `FW-PROTO-016`: remote press/release cannot interleave with continuous acquisition; resume occurs only after successful release and analyzer re-verification.
- `FW-PROTO-017`: D1–D4 overlay visibility is host-only, explicit, and cannot issue a firmware trace mutation.
- `FW-PROTO-018`: custom capability discovery accepts the complete multiline
  replies from Atom-Firmware `53850c4`, including the literal `usage:` prefixes
  and state lines, while rejecting partial/prose-contaminated variants.
- `FW-PROTO-019`: custom text-scan discovery uses only
  `scan ? ? ? ? ?`; `scan ?` is never sent and cannot trigger an acquisition.
- `FW-PROTO-021`: exact clean `tinySA4_hw-v0.3-fft1024-g43eb0f1` receives only
  the frozen-source 20–450 point proof after the same safe probes and restoration;
  cold 101-point state may retune FM/Band 14 to exact 449/450-point readback,
  while decorated identities and any prohibited feature remain fail-closed.
- `FW-PROTO-020`: every admitted physical firmware surface advertises `zero` as
  part of the composition-required command set; omission fails before session
  admission, while malformed `zero ?` evidence still withholds raw acquisition.
