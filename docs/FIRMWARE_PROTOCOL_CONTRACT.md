# ZS407 host protocol contract

Status: implementation baseline

Version: 2.0.0

Firmware source: `c97938697b6c7485e7cab50bca9af76996b7d671`

Target: tinySA Ultra+ ZS407 (`hwid` 103)

This contract is derived from the pinned firmware source in the sibling
`TinySA_Firmware` checkout. It replaces guessed serial behavior in the desktop
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

The following still require the ordered unit:

- the exact `version`, `info`, USB serial and descriptor strings shipped;
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

Atomizer requires these commands after `help` capability discovery:

| Domain | Commands |
| --- | --- |
| identity | `version`, `info`, `help` |
| lifecycle | `status`, `pause`, `resume`, `abort` |
| analyzer | `mode`, `sweep`, `scan`, `scanraw`, `rbw`, `attenuate`, `spur`, `avoid`, `lna`, `trigger`, `calc`, `trace`, `marker` |
| generator | `mode`, `freq`, `level`, `modulation`, `output` |
| diagnostics | `vbat`, `deviceid`, `capture` |
| remote panel | `touch`, `release` |

An absent required command is an unsupported-firmware error, not a reason to try
an alternate spelling or older protocol.

## Identity

`version` returns the firmware identifier on the first line. For tinySA4 it also
returns a line shaped like:

```text
HW Version:V0.5.4 + ZS407 max2871
```

Atomizer accepts only a ZS407 identity for a physical production session. The
simulator returns the same protocol identity with `simulated: true`. Other serial
ports remain visible for diagnostics but fail identification loudly.

## Firmware-derived ZS407 limits

| Capability | Contract |
| --- | ---: |
| normal analyzer ceiling | 900 MHz |
| Ultra transition (`6.3 GHz + 1.0701 GHz`) | 7.3701 GHz |
| default third-harmonic command ceiling | 17.9226 GHz |
| analyzer points | 20–450 (host-safe subset) |
| RBW command | 0.2–850 kHz or `auto` |
| attenuation command | 0–31 dB integer or `auto` |
| requested sweep time | 3 ms–60 s, or firmware minimum via zero |
| display | 480×320 RGB565 little-endian |
| raw RSSI representation | signed 16-bit little-endian, dB × 32 |

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

This is a command-capability statement, not a complete state-readback claim. The
shell query output does not round-trip every trace property reliably enough to
reconstruct four simultaneous traces; the pinned trace-list formatting also
does not expose the frozen argument as complete machine-readable state. Atomizer
therefore keeps the analyzer's unit command at `trace dBm` and derives its
simultaneous Clear/Write, Max Hold, Min Hold, Average, View/Freeze and Blank
frames from the exact host sweep arrays. Its eight marker readouts are derived
from those frames. Every such surface says `HOST MATH` and is governed by
`MEASUREMENT_CONTROLS_CONTRACT.md`.

No failed host projection falls through to firmware marker/trace manipulation or
remote screen touch. A future firmware-backed state mode requires explicit
request/result grammars, readback fixtures, a capability-profile revision, and a
separate evidence label.

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
"{" ("x" int16_le_db_x32){points} "}" "ch> "
```

The parser validates every marker and the exact point count. Binary payloads use
fixed length and cannot be delimited by searching for prompt bytes inside sample
data.

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

`capture` emits exactly `480 × 320 × 2 = 307,200` RGB565 little-endian bytes before
the prompt. `touch x y` accepts bounded panel coordinates. `release` optionally
accepts the final coordinates. Remote touch is a general instrument UI operation
and can reach RF controls; agent-driven remote touch is therefore high impact.

## Readback matrix

| State | Readback | Verification |
| --- | --- | --- |
| firmware/hardware identity | `version`, `info` | observed |
| command support | `help` | observed |
| analyzer range/points | `sweep` | verified |
| actual RBW | `rbw` query output | observed |
| actual attenuation | `attenuate` query output | observed |
| marker/trace slot counts | pinned firmware constants and `help` support | capability-derived |
| simultaneous desktop trace frames | complete acquired sweeps | host-derived |
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
- `FW-PROTO-006`: `scanraw` validates braces, sample markers and dB×32 decoding.
- `FW-PROTO-007`: screen capture consumes exactly 307,200 bytes before prompt.
- `FW-PROTO-008`: physical identity without ZS407 fails connection.
- `FW-PROTO-009`: generator configuration begins and ends muted.
- `FW-PROTO-010`: disconnect while output may be active yields `unknown` RF state.
- `FW-PROTO-011`: capability discovery requires both `trace` and `marker` and reports four/eight slots.
- `FW-PROTO-012`: desktop trace/marker projections remain labeled host-derived and never impersonate firmware readback.
